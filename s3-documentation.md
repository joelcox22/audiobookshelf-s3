# S3 Backend Support Plan for Audiobookshelf

## Executive Summary

This document analyses the current filesystem architecture of Audiobookshelf and produces a
detailed plan for adding AWS S3 as an optional storage backend for audiobook/podcast media files
and their associated metadata images (covers, author images) and image resize cache. The SQLite
database and ephemeral server-side state (HLS transcode segments) are explicitly out of scope and
will remain on local disk.

The primary user-experience goal is that **all network-heavy client requests—audio file streaming,
cover images, ebook downloads—bypass the Audiobookshelf server entirely and are served directly
from S3 public endpoints via read-only presigned URLs**. The server only handles lightweight
control-plane operations (catalogue queries, session management, playback progress) and performs
S3 API calls for its own write operations (episode downloads, cover uploads, scan). This allows
the server to be hosted on a slow connection while end-users still enjoy high-throughput file
delivery.

Each S3-backed library is independently configured with its own bucket, key prefix, AWS region,
and S3 endpoint, allowing users to spread libraries across different buckets or regions, or to
use S3-compatible services (MinIO, Cloudflare R2, etc.) per library. These settings are stored in
the database and managed through the existing library settings UI. AWS credentials are consumed
from the standard AWS SDK environment variables (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`). No in-application credential configuration UI
is required for credentials.

---

## 1. Current Filesystem Architecture

### 1.1 Directory Layout

The application uses two root path globals set at startup:

| Global | Typical default | Purpose |
|---|---|---|
| `global.MetadataPath` | `/config/metadata` | Server-managed metadata, cache, covers, author images |
| `libraryItem.path` | e.g. `/audiobooks/…` | The user-configured library folder root, where media files live |

Key sub-directories under `MetadataPath`:

```
metadata/
  items/{libraryItemId}/          ← Cover images (when storeCoverWithItem = false)
  authors/{authorId}.jpg          ← Author portrait images
  cache/
    covers/{itemId}_{w}x{h}.webp  ← Resized cover cache
    images/{authorId}_{w}x{h}.webp← Resized author image cache
    items/                        ← Audio metadata embed cache
  streams/{sessionId}/            ← HLS transcode segments (ephemeral)
  backups/                        ← Backup zip archives
  tmp/                            ← Temporary extraction directory (comic books)
```

When the server setting `storeCoverWithItem` is `true`, cover images are stored inside
`libraryItem.path` alongside the audio files rather than under `MetadataPath/items/`.

### 1.2 Complete Filesystem Touch-Point Inventory

The following table lists every place in the server code that performs a local-disk operation on
media or metadata files. Database operations (SQLite) are excluded as they are out of scope.

#### Reading / Serving files to clients

| Location | Operation | File type served |
|---|---|---|
| `server/controllers/SessionController.js` – `getTrack()` | `res.sendFile(audioTrack.metadata.path)` or `X-Accel-Redirect` | Audio tracks during direct playback |
| `server/controllers/LibraryItemController.js` – `getFile()` | `res.sendFile(libraryFile.metadata.path)` or `X-Accel-Redirect` | Individual library files (audio, image, text) |
| `server/controllers/LibraryItemController.js` – `downloadFile()` | `res.download(libraryFile.metadata.path, …)` or `X-Accel-Redirect` | Force-download of a single file |
| `server/controllers/LibraryItemController.js` – `downloadLibraryItem()` | `res.download(libraryItemPath)` or `zipHelpers.zipDirectoryPipe()` | Full item download (single file or zip) |
| `server/controllers/LibraryItemController.js` – `getCover()` | `res.sendFile(coverPath)` or `X-Accel-Redirect` (raw, no resize) | Cover image (no-resize path) |
| `server/controllers/LibraryItemController.js` – `getEbook()` | `res.sendFile(ebookFilePath)` or `X-Accel-Redirect` | Ebook file (epub, pdf, …) |
| `server/controllers/ShareController.js` – `getSharedItemCover()` | `res.sendFile(coverPath)` or `X-Accel-Redirect` | Cover for public share link |
| `server/controllers/ShareController.js` – `getSharedItemTrack()` | `res.sendFile(audioTrackPath)` or `X-Accel-Redirect` | Audio track for public share link |
| `server/controllers/AuthorController.js` – `getImage()` | `res.sendFile(author.imagePath)` (raw, no resize) | Author portrait (no-resize path) |
| `server/managers/CacheManager.js` – `handleCoverCache()` | `fs.createReadStream(cachePath).pipe(res)` or `X-Accel-Redirect` | Resized cover image |
| `server/managers/CacheManager.js` – `handleAuthorCache()` | `fs.createReadStream(cachePath).pipe(res)` | Resized author image |
| `server/routers/HlsRouter.js` – `streamFileRequest()` | `res.sendFile(fullFilePath)` | HLS `.ts` segments and `.m3u8` playlists (transcode output — stays local) |

#### Writing / Uploading files

| Location | Operation | File type written |
|---|---|---|
| `server/managers/CoverManager.js` – `uploadCover()` | `coverFile.mv(coverFullPath)` (multipart upload from client) | Cover image |
| `server/managers/CoverManager.js` – `downloadCoverFromUrlNew()` | `downloadImageFile(url, temppath)` then `fs.rename(temppath, coverFullPath)` | Cover image downloaded from external URL |
| `server/managers/CoverManager.js` – `saveEmbeddedCoverArt()` | `extractCoverArt(audioFilePath, coverFilePath)` via ffmpeg | Cover extracted from audio file tags |
| `server/managers/CoverManager.js` – `saveEbookCoverArt()` | `parseEbookMetadata.extractCoverImage(…, coverFilePath)` | Cover extracted from ebook |
| `server/managers/CoverManager.js` – `validateCoverPath()` | `fs.copy(coverPath, newCoverPath)` | Copy cover to managed directory |
| `server/finders/AuthorFinder.js` – `saveAuthorImage()` | `downloadImageFile(url, outputPath)` | Author portrait downloaded from external URL |
| `server/managers/PodcastManager.js` – `startPodcastEpisodeDownload()` | `ffmpegHelpers.downloadPodcastEpisode()` → local file, then `downloadFile(url, targetPath)` fallback | Podcast episode MP3/audio file |
| `server/managers/AudioMetadataManager.js` | ffmpeg tag-writing to audio file in-place | Audio file metadata tags |

#### Deleting files

| Location | Operation | Purpose |
|---|---|---|
| `server/managers/CoverManager.js` – `removeOldCovers()` | `fs.unlink(filepath)` | Remove stale cover variants after cover update |
| `server/managers/CoverManager.js` – `removeFile()` | `fs.unlink(filepath)` | Delete a cover or author image |
| `server/controllers/LibraryItemController.js` – `deleteLibraryItem()` | `fs.remove(libraryItemPath)` | Delete all media files for an item from disk |
| `server/controllers/LibraryItemController.js` – `deleteLibraryFile()` | `fs.remove(libraryFile.metadata.path)` | Delete a single file within an item |
| `server/managers/PodcastManager.js` | `fs.remove(targetPath)` | Remove partial/failed episode download |
| `server/managers/CacheManager.js` | `fs.unlink(cachePath)` | Purge individual cached image |
| `server/managers/CacheManager.js` – `purgeAll()` | `fs.remove(this.CachePath)` | Purge entire cache directory |

#### Directory / metadata operations

| Location | Operation | Purpose |
|---|---|---|
| `server/scanner/LibraryScanner.js` | `fileUtils.recurseFiles(folderPath)` | Walk library folder to discover all files |
| `server/scanner/LibraryItemScanner.js` | `fileUtils.recurseFiles(libraryItemPath)` | Walk a single item directory |
| `server/scanner/LibraryScanner.js` | `fileUtils.getFileTimestampsWithIno(path)` | Get mtime/ctime/size/inode for change detection |
| `server/objects/files/LibraryFile.js` – `setDataFromPath()` | `getFileTimestampsWithIno(path)` | Populate LibraryFile metadata from disk stats |
| `server/models/LibraryItem.js` | `getFileTimestampsWithIno(this.path)` | Detect library item folder modification |
| `server/managers/PlaybackSessionManager.js` | `fs.ensureDir(this.StreamsPath)`, `fs.readdir(this.StreamsPath)` | Set up and clean up HLS transcode output dirs |
| `server/managers/CacheManager.js` – `ensureCachePaths()` | `fs.ensureDir(…)` ×4 | Initialise cache sub-directories |
| `server/managers/CoverManager.js` | `fs.ensureDir(coverDirPath)`, `fs.readdir(dirPath)` | Create/inspect cover directory |
| `server/Watcher.js` | `chokidar`/`inotifywait` file-system watcher | React to new/changed/deleted files in library folders |
| `server/utils/fileUtils.js` – `checkPathIsFile()`, `getFileTimestampsWithIno()` | `fs.stat(path)` | General file validation |
| `server/utils/fileUtils.js` – `downloadFile()` | `fs.createWriteStream(filepath)` | Download remote file to local disk |

---

## 2. Proposed S3 Architecture

### 2.1 Design Principles

1. **Per-library storage type.** Each library has a `storageType` field (`local` | `s3`). Existing
   local libraries continue to work unchanged. A new library can be configured as S3-backed.

2. **Per-library S3 configuration.** Every S3-backed library carries its own `s3Bucket`,
   `s3Region`, `s3Endpoint`, and `s3KeyPrefix` in the database. This allows multiple independent
   S3 libraries, each pointing at a different bucket, region, prefix, or S3-compatible service.
   AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are the only global
   configuration — they are shared across all S3 libraries and are not stored in the application.

3. **Presigned URLs for client delivery.** When a client requests any file (audio track, ebook,
   cover image) from an S3-backed library, the server generates a short-lived read-only presigned
   URL and responds with `HTTP 302 Found` redirecting the client directly to S3. The file content
   never passes through the Audiobookshelf server.

4. **Local disk remains for ephemeral data.** HLS transcode segments, the resize image cache, the
   SQLite database, and in-progress download temp files are all kept on local disk. S3 is only used
   for durable, user-visible media and metadata images.

5. **`S3StorageManager` as a library-client factory.** Rather than a single global S3 client,
   `S3StorageManager` is a factory that returns per-library client handles. It caches `S3Client`
   instances keyed by `(region, endpoint)` so that libraries using the same region/endpoint share
   an HTTP connection pool. All other server components call `S3StorageManager.getLibraryClient()`
   and do not import the AWS SDK directly.

### 2.2 New Component: `server/managers/S3StorageManager.js`

This module wraps `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. It acts as a
**client factory and cache**: callers request a library-scoped client by passing the library's S3
configuration, and the factory returns a thin `S3LibraryClient` wrapper bound to that library's
bucket, prefix, region, and endpoint. `S3Client` instances (which own the HTTP connection pool)
are cached and reused across libraries that share the same `(region, endpoint)` pair.

**Environment variables consumed (all read-only at start-up):**

| Variable | Required | Description |
|---|---|---|
| `S3_PRESIGNED_URL_TTL_SECONDS` | No | Lifetime of generated presigned URLs; defaults to `18000` (5 hours). A longer default is chosen because audio files are large and buffered playback sessions commonly run for several hours; a URL expiring mid-listen would interrupt playback. Reduce this value in security-sensitive deployments. |
| `AWS_ACCESS_KEY_ID` | Yes* | Standard AWS SDK credential env var |
| `AWS_SECRET_ACCESS_KEY` | Yes* | Standard AWS SDK credential env var |

\* The AWS SDK also supports IAM instance profiles, ECS task roles, etc. Explicit key/secret are
not strictly required when running on AWS infrastructure.

**Public interface of `S3StorageManager` (the factory):**

```javascript
class S3StorageManager {
  get presignedUrlTtlSeconds()        // S3_PRESIGNED_URL_TTL_SECONDS, default 18000

  // Returns an S3LibraryClient bound to this library's config.
  // Throws if libraryConfig is missing required fields (bucket).
  getLibraryClient(libraryConfig)
  // libraryConfig: { bucket, keyPrefix?, region?, endpoint? }
}
```

**Public interface of `S3LibraryClient` (the per-library handle):**

```javascript
class S3LibraryClient {
  // Object lifecycle
  async putObject(key, bodyStream, contentType)
  async getObjectStream(key)               // returns a readable stream
  async headObject(key)                    // returns { size, lastModified } or null
  async deleteObject(key)                  // deletes a single object
  async deleteObjects(keys)               // batch delete (up to 1000 keys per call)
  async listObjects(prefix)               // returns array of { key, size, lastModified }
  async copyObject(sourceKey, destKey)

  // Client delivery
  async getPresignedGetUrl(key, ttlSeconds?) // returns a time-limited GET URL
  async getPresignedPutUrl(key, ttlSeconds?) // returns a time-limited PUT URL (for future direct upload)

  // Key helpers
  buildKey(relPath)                        // prepend keyPrefix to a relative path
  keyToRelPath(key)                        // strip keyPrefix to get a relative path
}
```

### 2.3 S3 Object Key Convention

S3 object keys are formed by joining the library's `s3KeyPrefix` (stored in the `Library` record)
with the item's relative path within the library. The `s3KeyPrefix` acts as the virtual root
folder for this library inside its bucket — equivalent to the library's local folder path.

Because every library has its own bucket and/or key prefix, no additional `library/{libraryId}/`
wrapper is needed in the key: the prefix alone is sufficient to separate libraries that share a
bucket.

| Content | Local path example | S3 key (with `s3KeyPrefix = "audiobooks/"`) | S3 key (no prefix) |
|---|---|---|---|
| Audio file | `/audiobooks/Terry Pratchett/Guards Guards/Guards Guards.m4b` | `audiobooks/Terry Pratchett/Guards Guards/Guards Guards.m4b` | `Terry Pratchett/Guards Guards/Guards Guards.m4b` |
| Episode file | `/podcasts/My Podcast/episode-001.mp3` | `podcasts/My Podcast/episode-001.mp3` | `My Podcast/episode-001.mp3` |
| Item cover (stored with item) | `/audiobooks/Author/Book/cover.jpg` | `audiobooks/Author/Book/cover.jpg` | `Author/Book/cover.jpg` |
| Item cover (metadata folder) | `/config/metadata/items/li_abc123/cover.jpg` | `audiobooks/.abs/metadata/items/li_abc123/cover.jpg` | `.abs/metadata/items/li_abc123/cover.jpg` |
| Ebook file | `/audiobooks/Author/Book/Book.epub` | `audiobooks/Author/Book/Book.epub` | `Author/Book/Book.epub` |
| Resized cover | `/config/metadata/cache/covers/li_abc123_300x300.webp` | `audiobooks/__resize_cache__/covers/li_abc123_300x300.webp` | `__resize_cache__/covers/li_abc123_300x300.webp` |

Server-managed metadata (cover images stored in the metadata folder when `storeCoverWithItem` is
`false`) are stored inside a `.abs/metadata/` sub-directory appended to the library's own
`s3KeyPrefix`. For example, if `s3KeyPrefix = 'audiobooks/'`, item covers go to
`audiobooks/.abs/metadata/items/{libraryItemId}/cover.jpg`. This keeps all data for a library
self-contained under its prefix and avoids any collision with actual media files. Author images
remain on local disk because they are not library-specific (an author can appear across multiple
libraries).

### 2.4 Data Flow — File Serving (current vs. proposed)

**Current (local):**
```
Client → GET /api/items/:id/file/:fileid
           → Server: fs.stat(path) → res.sendFile(path)
                                           ↓
                                    Server streams bytes → Client
```

**Proposed (S3-backed library):**
```
Client → GET /api/items/:id/file/:fileid
           → Server: libraryClient = S3StorageManager.getLibraryClient(library.s3Config)
           → Server: libraryClient.getPresignedGetUrl(key)
           → HTTP 302 Location: https://s3.amazonaws.com/bucket/key?X-Amz-Signature=…
                                           ↓
                            Client downloads directly from S3
```

The same redirect pattern applies to:
- Audio track streaming (`SessionController.getTrack`)
- Cover image serving (`CacheManager.handleCoverCache`, `LibraryItemController.getCover`)
- Author image serving (`AuthorController.getImage`, `CacheManager.handleAuthorCache`)
- Ebook serving (`LibraryItemController.getEbook`)
- Public share track & cover (`ShareController`)
- Single-file and full-item downloads (`LibraryItemController.downloadFile`,
  `LibraryItemController.downloadLibraryItem`)

### 2.5 Data Flow — Writing (current vs. proposed)

**Podcast episode download (current):**
```
External RSS URL → ffmpeg / axios → local disk file → LibraryFile.setDataFromPath()
```

**Podcast episode download (proposed, S3 library):**
```
External RSS URL → ffmpeg / axios → temp local file → libraryClient.putObject(key, stream)
                                                    → fs.unlink(tempFile)
                                                    → libraryFile metadata populated from S3 headObject
```

**Cover upload (current):**
```
Multipart POST → temp file → CoverManager.uploadCover() → fs.mv() → local cover path
```

**Cover upload (proposed, S3 library):**
```
Multipart POST → temp file → CoverManager.uploadCover()
                                → libraryClient.putObject(coverKey, readStream)
                                → fs.unlink(tempFile)
```

---

## 3. Component-by-Component Change Plan

### 3.1 Library Model — Add S3 configuration fields

**File:** `server/models/Library.js`

Add new columns to the `Library` Sequelize model and corresponding DB migration:

```javascript
storageType: {
  type: DataTypes.STRING,
  allowNull: false,
  defaultValue: 'local'   // existing libraries remain unchanged
},
s3Bucket: {
  type: DataTypes.STRING,
  allowNull: true          // null for local libraries
},
s3Region: {
  type: DataTypes.STRING,
  allowNull: true          // null → AWS SDK default / AWS_REGION env var
},
s3Endpoint: {
  type: DataTypes.STRING,
  allowNull: true          // null for standard AWS S3; set for MinIO, R2, etc.
},
s3KeyPrefix: {
  type: DataTypes.STRING,
  allowNull: true          // null / '' → no prefix; e.g. 'audiobooks/' or 'podcasts/fiction/'
}
```

A helper `library.s3Config` getter on the model assembles these fields into the shape expected
by `S3StorageManager.getLibraryClient()`:

```javascript
get s3Config() {
  if (this.storageType !== 's3') return null
  return {
    bucket: this.s3Bucket,
    keyPrefix: this.s3KeyPrefix || '',
    region: this.s3Region || undefined,
    endpoint: this.s3Endpoint || undefined
  }
}
```

**Migration file:** `server/migrations/v2.XX.0-add-library-storage-type.js`

### 3.2 New File: `server/managers/S3StorageManager.js`

Implement the factory interface described in §2.2. Key implementation notes:

- Use `@aws-sdk/client-s3` v3 modular client (smaller bundle, tree-shakeable).
- Use `@aws-sdk/s3-request-presigner` for `getSignedUrl`.
- `S3StorageManager` is exported as a singleton module. It maintains an internal cache of
  `S3Client` instances keyed by a composite string of `region` and `endpoint`
  (e.g. `JSON.stringify({ region, endpoint })`) to reuse HTTP connection pools
  across libraries that share the same region and endpoint.
- `getLibraryClient(libraryConfig)` validates that `libraryConfig.bucket` is present and
  returns a new `S3LibraryClient` instance (lightweight wrapper — instantiation is cheap).
- `S3LibraryClient` closes over the cached `S3Client` and the library's `bucket`/`keyPrefix`.
- The presigned URL TTL is read once from `S3_PRESIGNED_URL_TTL_SECONDS` at module load
  (default `18000`); it is accessible via `S3StorageManager.presignedUrlTtlSeconds`.

**New dependency:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### 3.3 Helper: `isS3Library(libraryIdOrObject)` and `getLibraryS3Config(libraryIdOrObject)`

Two utilities in `server/utils/storageUtils.js`:

**`isS3Library(libraryIdOrObject)`** returns `true` when a library has `storageType === 's3'`.
The helper accepts any of:

- A **`Library` model instance** — reads `library.storageType` directly.
- A **`LibraryItem` model instance** — reads `libraryItem.library?.storageType` if the association
  is already loaded, otherwise falls back to a cached lookup by `libraryItem.libraryId`.
- A **library ID string** — looks up the library from the in-memory cache.

**`getLibraryS3Config(libraryIdOrObject)`** returns the full S3 configuration object
`{ bucket, keyPrefix, region, endpoint }` for an S3 library, or `null` for a local library.

Because `Library` records are small and rarely change, the server should maintain an in-memory
map of `libraryId → { storageType, s3Bucket, s3KeyPrefix, s3Region, s3Endpoint }` that is
refreshed whenever a library is created or updated. This avoids a SQL round-trip on every
file-serve request. All branching in controllers and managers uses these helpers.

### 3.4 `server/controllers/SessionController.js` — `getTrack()`

**Current behaviour:** `res.sendFile(audioTrack.metadata.path)` (or X-Accel-Redirect).

**Proposed change:**

```javascript
const s3Config = getLibraryS3Config(playbackSession.libraryId)
if (s3Config) {
  const libraryClient = S3StorageManager.getLibraryClient(s3Config)
  const key = libraryClient.buildKey(audioTrack.metadata.relPath)
  const url = await libraryClient.getPresignedGetUrl(key)
  return res.redirect(url)
}
// existing local path …
```

`audioTrack.metadata.relPath` is the path relative to the library folder root, already stored in
the DB (`LibraryFile.metadata.relPath`).

### 3.5 `server/controllers/LibraryItemController.js`

Multiple endpoints need the redirect treatment:

| Method | Change |
|---|---|
| `getFile()` | If S3 library → presigned URL redirect instead of `sendFile` |
| `downloadFile()` | If S3 library → presigned URL redirect (browser will see `Content-Disposition: attachment` if the key metadata includes it, or add it via response headers in the signed URL) |
| `downloadLibraryItem()` | Single-file S3 items: presigned redirect. Multi-file items: stream objects from S3 into the zip pipe. |
| `getCover()` | If S3 library → presigned URL redirect for cover key |
| `getEbook()` | If S3 library → presigned URL redirect for ebook key |
| `deleteCover()` | If S3 library → `libraryClient.deleteObject(coverKey)` |
| `deleteLibraryItem()` | If S3 library → `libraryClient.deleteObjects(allItemKeys)` (list prefix first) |
| `deleteLibraryFile()` | If S3 library → `libraryClient.deleteObject(fileKey)` |

### 3.6 `server/controllers/AuthorController.js`

Author images are stored on local disk regardless of library storage type (see §3.10). No changes
are required to `AuthorController.getImage()` or `AuthorController.deleteImage()`.

### 3.7 `server/controllers/ShareController.js`

| Method | Change |
|---|---|
| `getSharedItemCover()` | If S3 library → presigned URL redirect |
| `getSharedItemTrack()` | If S3 library → presigned URL redirect |
| `downloadSharedLibraryItem()` | If S3 library → presigned redirect or zip-from-S3 |

### 3.8 `server/managers/CoverManager.js`

This manager handles all cover image lifecycle. All five write operations need S3 variants:

| Method | Change |
|---|---|
| `uploadCover(libraryItem, coverFile)` | If S3 library: `putObject(coverKey, fs.createReadStream(coverFile.tempFilePath))`, then `fs.unlink(temp)`. Skip `ensureDir`. |
| `downloadCoverFromUrlNew(url, …)` | If S3 library: download to OS temp dir → validate → `putObject(coverKey, …)` → delete temp |
| `saveEmbeddedCoverArt(audioFiles, …)` | If S3 library: ffmpeg extracts to OS temp → `putObject(coverKey, …)` → delete temp |
| `saveEbookCoverArt(…)` | Same pattern as `saveEmbeddedCoverArt` |
| `validateCoverPath(coverPath, …)` | S3 libraries do not support a user-supplied local `coverPath`; return an error for this case |
| `removeOldCovers(dirpath, newCoverExt)` | If S3 library: `listObjects(itemPrefix)` → filter by name pattern → `deleteObjects(staleKeys)` |
| `removeFile(filepath)` | If the path is an S3 key (detect by absence of filesystem root `/`): `deleteObject(key)` |
| `checkFileIsValidImage(imagepath)` | Stays local (always called after downloading to a temp path, which remains local) |

The cover path stored in `libraryItem.media.coverPath` (and returned to the client) must also be
updated. For S3 libraries, `coverPath` should store the S3 object key (e.g.
`metadata/items/li_abc/cover.jpg`) rather than an absolute filesystem path. Controllers and the
CacheManager then detect this format to resolve it correctly.

### 3.9 `server/managers/CacheManager.js`

For S3-backed libraries the resize cache is **stored in S3** under the library's own bucket and
key prefix, using a `__resize_cache__/` sub-prefix. This means resized images are served via
presigned URL redirects just like all other S3 content, and the local disk is not needed for
cache storage when the library is S3-backed.

#### Resize cache key convention

```
{s3KeyPrefix}__resize_cache__/covers/{libraryItemId}_{width}x{height}.webp
```

For example, with `s3KeyPrefix = 'audiobooks/'`:
```
audiobooks/__resize_cache__/covers/li_abc123_300x300.webp
```

The `__resize_cache__` component is a reserved prefix. The server will treat any path component
that begins with `__resize_cache__` as server-generated content and will refuse to register it
as a media file path during library scanning. Users should avoid naming library folders or files
with this prefix, and the scanner will emit a warning if it encounters one.

#### **`handleCoverCache(res, libraryItemId, options)`** — proposed S3 flow

```
1. Get the library s3Config for this libraryItemId.
2. If S3 library:
   a. Build the resize cache key:
      cacheKey = libraryClient.buildKey(`__resize_cache__/covers/${libraryItemId}_${w}x${h}.webp`)
   b. If headObject(cacheKey) returns metadata → presigned URL redirect (cache hit).
   c. Cache miss:
      - Get the source cover S3 key from DB (coverPath stored as S3 key).
      - Stream the source cover from S3 to a local OS temp file.
      - Resize the temp file (sharp/ffmpeg) into a second local temp file.
      - Upload the resized temp file to S3 at cacheKey via putObject().
      - Delete both local temp files.
      - Presigned URL redirect to the newly cached object.
3. If local library:
   - Existing logic unchanged (local disk cache).
```

#### **`handleAuthorCache`**

Author images remain on local disk (see §3.10), so `handleAuthorCache` continues to use the
existing local disk cache logic unchanged.

#### Cache purge operations

| Method | Change |
|---|---|
| `purgeAll()` | If S3 library: `libraryClient.deleteObjects(await libraryClient.listObjects('__resize_cache__/'))` — the S3 delete replaces the local `fs.remove(this.CachePath)` for that library (no local cache files are written for S3 libraries, so no local cleanup is needed) |
| `purge(libraryItemId)` | If S3 library: list objects matching `__resize_cache__/covers/${libraryItemId}_*` → `deleteObjects(keys)` |

### 3.10 `server/finders/AuthorFinder.js` — `saveAuthorImage()`

Author images are server-managed metadata that can be shared across multiple libraries (the same
author may appear in several libraries, each potentially using a different S3 bucket). Because
there is no single canonical bucket for server-managed metadata, **author images continue to be
stored on local disk** at `MetadataPath/authors/{authorId}.jpg`. No changes are required to
`AuthorFinder.saveAuthorImage()`.

The `AuthorController.getImage()` and `CacheManager.handleAuthorCache()` endpoints are
therefore also unchanged — they continue to serve author images from the local filesystem.

> **Future enhancement:** A dedicated `S3_METADATA_BUCKET` / `S3_METADATA_REGION` env var pair
> could be introduced to allow author images and other server-managed metadata to be stored in a
> single global S3 location, but this is out of scope for the current plan.

### 3.11 `server/managers/PodcastManager.js` — `startPodcastEpisodeDownload()`

```javascript
// After successful ffmpeg download to this.currentDownload.targetPath …
const s3Config = getLibraryS3Config(this.currentDownload.libraryItem.libraryId)
if (s3Config) {
  const libraryClient = S3StorageManager.getLibraryClient(s3Config)
  const key = libraryClient.buildKey(this.currentDownload.targetRelPath)
  await libraryClient.putObject(key, fs.createReadStream(this.currentDownload.targetPath))
  await fs.unlink(this.currentDownload.targetPath)
}
// scan/probe logic follows, using the key or local path accordingly
```

`LibraryFile.setDataFromPath()` currently calls `getFileTimestampsWithIno()` to populate size and
timestamps. For S3 files, this must be replaced with a `headObject` call (see §3.13).

### 3.12 `server/managers/AudioMetadataManager.js`

Writing metadata tags (e.g. "embed cover into MP3") requires a local file. For S3 libraries:

1. Stream the audio file from S3 to a local temp path.
2. Run ffmpeg tag-writing on the local temp file.
3. Upload the modified file back to S3 (overwrite same key).
4. Delete the local temp file.

This is the most complex write-back scenario. It may be deferred to a later implementation phase.

### 3.13 `server/objects/files/LibraryFile.js` — `setDataFromPath()`

Add an S3-aware variant. The caller passes the `S3LibraryClient` instance for the library,
which is already required to have resolved the library config before calling this method:

```javascript
async setDataFromS3Key(key, relPath, libraryClient) {
  const meta = await libraryClient.headObject(key)
  this.ino = key        // use key as the stable inode equivalent
  this.metadata.filename = Path.basename(relPath)
  this.metadata.ext = Path.extname(relPath)
  this.metadata.path = key      // stored as S3 key in DB
  this.metadata.relPath = relPath
  this.metadata.size = meta?.size ?? 0
  this.addedAt = meta?.lastModified?.getTime() ?? Date.now()
  this.updatedAt = this.addedAt
}
```

The `ino` (inode) field is currently used as a stable file identifier in the database. For S3
files, the object key serves this role. Existing queries that join on `ino` must be verified to
work with key-based identifiers.

### 3.14 `server/scanner/LibraryScanner.js` — `scanLibraryFolders()`

**Current:** `fileUtils.recurseFiles(folderPath)` walks the local directory tree.

**Proposed (S3 library):**

```javascript
if (library.storageType === 's3') {
  const libraryClient = S3StorageManager.getLibraryClient(library.s3Config)
  const s3Objects = await libraryClient.listObjects('')   // list from root of library prefix
  fileItems = s3Objects.map(obj => ({
    fullpath: obj.key,
    path: libraryClient.keyToRelPath(obj.key),
    extension: Path.extname(obj.key),
    deep: libraryClient.keyToRelPath(obj.key).split('/').length - 1,
    size: obj.size,
    mtimeMs: obj.lastModified.getTime()
  }))
}
```

`getFileTimestampsWithIno()` calls on the resulting file items must also be skipped (the data
comes from `listObjects` directly).

### 3.15 `server/Watcher.js`

The filesystem watcher (`chokidar`) has no meaning for S3-backed libraries. Two options:

- **Option A (simple):** Simply do not start `chokidar` for S3 libraries. Re-scan must be triggered
  manually from the UI or on a schedule.
- **Option B (polling):** Periodically call `libraryClient.listObjects(prefix)` and diff against
  the last known list. Trigger a library item re-scan when new objects appear. This is equivalent
  to chokidar's polling mode.

Option A is recommended for the initial implementation. The existing manual "re-scan library" UI
action covers the use-case. Option B can be added later as an enhancement.

### 3.16 HLS Transcoding (`server/objects/Stream.js`, `server/routers/HlsRouter.js`)

The HLS transcoder runs entirely server-side and writes `.ts` segments to
`MetadataPath/streams/{sessionId}/`. These are ephemeral and served by `HlsRouter`. No S3 changes
are needed here — **however**, the *input* to ffmpeg must change for S3-backed libraries:

**Current:** ffmpeg input is a local file path.

**Proposed (S3 library):** Generate a presigned GET URL for the audio file and pass it directly to
ffmpeg as the input URI. FFmpeg natively supports HTTP/HTTPS URLs as input sources, so no
intermediate download is necessary.

```javascript
// In Stream.js startTranscode() or equivalent:
let inputPath = this.audioFile.metadata.path
const s3Config = getLibraryS3Config(this.libraryId)
if (s3Config) {
  const libraryClient = S3StorageManager.getLibraryClient(s3Config)
  const key = libraryClient.buildKey(this.audioFile.metadata.relPath)
  inputPath = await libraryClient.getPresignedGetUrl(key, S3StorageManager.presignedUrlTtlSeconds)
}
// ffmpeg -i inputPath …
```

---

## 4. Library Configuration

### 4.1 Creating an S3 Library

When a user creates a new library in the Audiobookshelf UI and selects "S3" as the storage type,
the following additional fields must be provided:

| Field | Required | Description |
|---|---|---|
| **S3 Bucket** | Yes | The name of the S3 bucket that holds this library's files |
| **S3 Key Prefix** | No | Sub-path within the bucket acting as the library root (e.g. `audiobooks/` or `podcasts/thriller/`). Leave blank if the bucket is dedicated to this library. |
| **S3 Region** | No | AWS region of the bucket (e.g. `us-east-1`). Falls back to the `AWS_REGION` env var if omitted. |
| **S3 Endpoint** | No | Custom endpoint URL for S3-compatible storage (MinIO, Cloudflare R2, etc.). Leave blank for standard AWS S3. |

Multiple S3 libraries may use the same bucket (differentiated by distinct `s3KeyPrefix` values),
different buckets in the same region, or entirely separate buckets in different regions or even
different S3-compatible services.

### 4.2 Library Model Changes

```javascript
// New fields on the Library Sequelize model
storageType:  DataTypes.STRING  // 'local' | 's3', default 'local'
s3Bucket:     DataTypes.STRING  // required when storageType = 's3'
s3KeyPrefix:  DataTypes.STRING  // optional; e.g. 'audiobooks/'
s3Region:     DataTypes.STRING  // optional; falls back to AWS_REGION env var
s3Endpoint:   DataTypes.STRING  // optional; custom endpoint for S3-compatible storage
```

---

## 5. Cover Path Storage Convention

Currently `libraryItem.media.coverPath` is an absolute local filesystem path (e.g.
`/config/metadata/items/li_abc/cover.jpg`). For S3 libraries, this field must store the S3 object
key instead (e.g. `audiobooks/.abs/metadata/items/li_abc/cover.jpg` when `s3KeyPrefix =
'audiobooks/'`).

To maintain backwards compatibility and allow the code to tell the two formats apart:
- Local paths always start with `/` (POSIX) or a drive letter (Windows).
- S3 keys never start with `/` and never contain `://`.

The helper `isS3Key(path)` — `return !path.startsWith('/') && !path.includes('://')` — can be used
wherever code needs to branch on path type.

---

## 6. Client-Facing API Contract

No changes to the existing REST API surface are required. The change is transparent to clients:
- Requests to `/api/items/:id/cover`, `/public/session/:id/track/:index`, etc. continue to work.
- The server responds with `HTTP 302 Found` (presigned URL redirect) instead of the file bytes
  for S3-backed libraries.
- All current web and mobile clients already handle HTTP redirects correctly.

For the *upload* direction (cover upload, future direct-upload feature), the server can optionally
expose a `GET /api/items/:id/cover/upload-url` endpoint that returns a presigned PUT URL, allowing
the browser to upload directly to S3 without proxying through the server. This is an optional
future optimisation.

---

## 7. Migration Strategy for Existing Local Libraries

Migrating an existing local library to S3 is a data operation, not a code change. The recommended
flow (documented for users, not automated by the application at this stage):

1. User creates an S3 bucket and configures AWS credentials via environment variables.
2. User uploads their existing library folder tree to the bucket using the AWS CLI or S3 sync tool,
   matching the intended `s3KeyPrefix`:
   `aws s3 sync /audiobooks/ s3://my-bucket/audiobooks/`
3. If covers are stored in the metadata folder (`storeCoverWithItem = false`), upload them into the
   `.abs/metadata/` sub-directory within the library prefix (the `.abs/metadata/` suffix is
   literal, not a placeholder):
   `aws s3 sync /config/metadata/items/ s3://my-bucket/audiobooks/.abs/metadata/items/`
4. User changes the library `storageType` to `s3` in the UI and fills in `s3Bucket`,
   `s3KeyPrefix`, `s3Region`, and `s3Endpoint` as appropriate.
5. User triggers a full library re-scan so the server updates `libraryFile.metadata.path` records
   from local paths to S3 keys.

Each library is migrated independently, so a mixed deployment (some libraries local, some S3) is
fully supported and requires no special configuration beyond the per-library settings above.

---

## 8. Implementation Phases

### Phase 1 — Foundation

1. Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `package.json`.
2. Implement `server/managers/S3StorageManager.js` (factory + `S3LibraryClient`).
3. Add `storageType`, `s3Bucket`, `s3Region`, `s3Endpoint`, `s3KeyPrefix` columns to `Library`
   model + write the DB migration.
4. Implement `server/utils/storageUtils.js` (`isS3Library`, `getLibraryS3Config`, `isS3Key` helpers).

### Phase 2 — File Serving (read path, highest impact)

5. Update `SessionController.getTrack()` — presigned URL redirect for S3 libraries.
6. Update `LibraryItemController.getFile()`, `downloadFile()`, `getCover()`, `getEbook()`.
7. Update `ShareController.getSharedItemCover()`, `getSharedItemTrack()`.
8. Update `AuthorController.getImage()`.
9. Update `CacheManager.handleCoverCache()` to source the cover from S3, resize it, store the
   resized image back to S3 under `__resize_cache__/covers/`, and serve via presigned URL redirect.
   Keep `handleAuthorCache()` on local disk (author images stay local).

### Phase 3 — Write Path

10. Update `CoverManager` (upload, download-from-URL, extract-embedded, extract-ebook,
    remove-old, remove).
11. Update `AuthorFinder.saveAuthorImage()`.
12. Update `PodcastManager.startPodcastEpisodeDownload()`.
13. Update `LibraryFile.setDataFromPath()` / add `setDataFromS3Key()`.

### Phase 4 — Library Scanning

14. Update `LibraryScanner.scanLibraryFolders()` to use `listObjects` for S3 libraries.
15. Disable `Watcher` for S3 libraries (Option A — no polling).
16. Update `getFileTimestampsWithIno()` call-sites to skip for S3 files or use `headObject`.

### Phase 5 — Transcoding Input

17. Update `Stream.js` to use presigned URL as ffmpeg input source for S3 libraries.

### Phase 6 — Tag Writing (deferred)

18. Update `AudioMetadataManager` to use download-modify-upload pattern for S3 libraries.

### Phase 7 — Delete Operations

19. Update `deleteLibraryItem()`, `deleteLibraryFile()`, `deleteCover()`, `deleteAuthorImage()`
    to use `libraryClient.deleteObject(s)` for S3 libraries.

---

## 9. Files to Create or Modify

### New files

| File | Purpose |
|---|---|
| `server/managers/S3StorageManager.js` | AWS S3 SDK wrapper singleton |
| `server/utils/storageUtils.js` | `isS3Library()`, `getLibraryS3Config()`, `isS3Key()` helpers |
| `server/migrations/v2.XX.0-add-library-storage-type.js` | DB migration adding `storageType`, `s3Bucket`, `s3Region`, `s3Endpoint`, `s3KeyPrefix` to `Libraries` table |

### Modified files

| File | Nature of change |
|---|---|
| `package.json` | Add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| `server/models/Library.js` | Add `storageType`, `s3Bucket`, `s3Region`, `s3Endpoint`, `s3KeyPrefix` Sequelize fields; add `s3Config` getter |
| `server/managers/S3StorageManager.js` | *(new)* |
| `server/managers/CoverManager.js` | S3 branches in all write operations |
| `server/managers/CacheManager.js` | S3 libraries: store resized cover images in S3 under `__resize_cache__/`; serve via presigned URL; S3-aware purge; `handleAuthorCache` unchanged |
| `server/managers/PodcastManager.js` | Upload downloaded episode to S3 |
| `server/managers/AudioMetadataManager.js` | Download-modify-upload for S3 libraries (Phase 6) |
| `server/finders/AuthorFinder.js` | Upload author image to S3 |
| `server/controllers/SessionController.js` | Presigned URL redirect for S3 audio tracks |
| `server/controllers/LibraryItemController.js` | Presigned URL redirect for S3 file/cover/ebook; S3 delete |
| `server/controllers/AuthorController.js` | No S3 changes required (author images remain on local disk) |
| `server/controllers/ShareController.js` | Presigned URL redirect for shared item track/cover |
| `server/scanner/LibraryScanner.js` | `listObjects` for S3 library folder scan |
| `server/objects/files/LibraryFile.js` | Add `setDataFromS3Key()` method |
| `server/objects/Stream.js` | Presigned URL as ffmpeg input source |
| `server/Watcher.js` | Skip watching for S3 libraries |

---

## 10. Out of Scope

The following are explicitly excluded from this plan, as agreed in the requirements:

- SQLite database — always stored on local disk.
- AWS credential configuration in the application UI — `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` are environment variables only; per-library S3 settings (bucket,
  region, endpoint, prefix) are stored in the database and managed through the UI.
- S3 support for backup archives (`BackupManager`) — backups cover the database, which stays local.
- HLS transcode segment storage in S3 — segments are ephemeral and always local.
- Author image storage in S3 — author images are server-managed metadata that span multiple
  libraries, and are stored on local disk.
- Direct-to-S3 browser uploads (presigned PUT URLs) — a future optimisation.
- Automatic migration tooling for existing local libraries to S3.
