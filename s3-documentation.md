# S3 Backend Support Plan for Audiobookshelf

## Executive Summary

This document analyses the current filesystem architecture of Audiobookshelf and produces a
detailed plan for adding AWS S3 as an optional storage backend for audiobook/podcast media files
and their associated metadata images (covers, author images). The SQLite database and ephemeral
server-side state (HLS transcode segments, resize cache) are explicitly out of scope and will
remain on local disk.

The primary user-experience goal is that **all network-heavy client requests—audio file streaming,
cover images, ebook downloads—bypass the Audiobookshelf server entirely and are served directly
from S3 public endpoints via read-only presigned URLs**. The server only handles lightweight
control-plane operations (catalogue queries, session management, playback progress) and performs
S3 API calls for its own write operations (episode downloads, cover uploads, scan). This allows
the server to be hosted on a slow connection while end-users still enjoy high-throughput file
delivery.

AWS credentials are consumed from the standard AWS SDK environment variables
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_SESSION_TOKEN`). No
in-application credential configuration UI is required.

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

2. **Server-side S3 SDK only.** The server itself uses the AWS SDK (`@aws-sdk/client-s3`,
   `@aws-sdk/s3-request-presigner`) for all reads and writes. Credentials are provided exclusively
   through the standard AWS environment variables — no UI configuration is needed.

3. **Presigned URLs for client delivery.** When a client requests any file (audio track, ebook,
   cover image) from an S3-backed library, the server generates a short-lived read-only presigned
   URL and responds with `HTTP 302 Found` redirecting the client directly to S3. The file content
   never passes through the Audiobookshelf server.

4. **Local disk remains for ephemeral data.** HLS transcode segments, the resize image cache, the
   SQLite database, and in-progress download temp files are all kept on local disk. S3 is only used
   for durable, user-visible media and metadata images.

5. **New `S3StorageManager`** is the single point of contact with AWS. All other server components
   call this manager; they do not import the AWS SDK directly.

### 2.2 New Component: `server/managers/S3StorageManager.js`

This class wraps `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. It is instantiated as
a singleton and initialised from environment variables when the server starts.

**Environment variables consumed (all read-only at start-up):**

| Variable | Required | Description |
|---|---|---|
| `S3_BUCKET` | Yes (if any S3 library is configured) | Bucket name |
| `S3_REGION` | No | Overrides `AWS_REGION` for the S3 client |
| `S3_KEY_PREFIX` | No | Optional prefix prepended to every object key (e.g. `audiobookshelf/`) |
| `S3_ENDPOINT` | No | Custom endpoint URL for S3-compatible storage (e.g. MinIO, Cloudflare R2) |
| `S3_PRESIGNED_URL_TTL_SECONDS` | No | Lifetime of generated presigned URLs; defaults to `3600` (1 hour) |
| `AWS_ACCESS_KEY_ID` | Yes* | Standard AWS SDK credential env var |
| `AWS_SECRET_ACCESS_KEY` | Yes* | Standard AWS SDK credential env var |
| `AWS_REGION` | Yes* | Standard AWS SDK region env var |

\* The AWS SDK also supports IAM instance profiles, ECS task roles, etc. Explicit key/secret are
not strictly required when running on AWS infrastructure.

**Public interface of `S3StorageManager`:**

```javascript
class S3StorageManager {
  get isEnabled()                          // true if S3_BUCKET is set

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
  buildKey(relPath)                        // prepend S3_KEY_PREFIX to a relative path
  keyToRelPath(key)                        // strip S3_KEY_PREFIX to get a relative path
}
```

### 2.3 S3 Object Key Convention

S3 object keys mirror the relative path structure that already exists on disk. The `S3_KEY_PREFIX`
(if set) acts like a virtual root folder inside the bucket, so multiple Audiobookshelf instances
can share a bucket.

| Content | Local path example | S3 key example (no prefix) |
|---|---|---|
| Audio file | `/audiobooks/Terry Pratchett/Guards Guards/Guards Guards.m4b` | `library/{libraryId}/Terry Pratchett/Guards Guards/Guards Guards.m4b` |
| Episode file | `/podcasts/My Podcast/episode-001.mp3` | `library/{libraryId}/My Podcast/episode-001.mp3` |
| Item cover | `/config/metadata/items/li_abc123/cover.jpg` | `metadata/items/li_abc123/cover.jpg` |
| Author image | `/config/metadata/authors/au_xyz789.jpg` | `metadata/authors/au_xyz789.jpg` |
| Ebook file | `/audiobooks/Author/Book/Book.epub` | `library/{libraryId}/Author/Book/Book.epub` |

The `library/{libraryId}/` prefix is derived from the library's database ID so multiple libraries
in the same bucket are kept separate.

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
           → Server: S3StorageManager.getPresignedGetUrl(key)
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
External RSS URL → ffmpeg / axios → temp local file → S3StorageManager.putObject(key, stream)
                                                    → fs.unlink(tempFile)
                                                    → libraryFile metadata populated from S3 HeadObject
```

**Cover upload (current):**
```
Multipart POST → temp file → CoverManager.uploadCover() → fs.mv() → local cover path
```

**Cover upload (proposed, S3 library):**
```
Multipart POST → temp file → CoverManager.uploadCover()
                                → S3StorageManager.putObject(coverKey, readStream)
                                → fs.unlink(tempFile)
```

---

## 3. Component-by-Component Change Plan

### 3.1 Library Model — Add `storageType`

**File:** `server/models/Library.js`

Add a new column to the `Library` Sequelize model and corresponding DB migration:

```javascript
storageType: {
  type: DataTypes.STRING,
  allowNull: false,
  defaultValue: 'local'   // existing libraries remain unchanged
}
```

A `storageType: 's3'` library also requires `libraryId` to be known at key-building time, which is
already available everywhere `libraryItem.libraryId` is accessible.

**Migration file:** `server/migrations/v2.XX.0-add-library-storage-type.js`

### 3.2 New File: `server/managers/S3StorageManager.js`

Implement the interface described in §2.2. Key implementation notes:

- Use `@aws-sdk/client-s3` v3 modular client (smaller bundle, tree-shakeable).
- Use `@aws-sdk/s3-request-presigner` for `getSignedUrl`.
- The singleton instance is exported from the module; a lazy `init()` call (called at server start)
  reads env vars and creates the `S3Client` instance.
- All methods are no-ops (or throw a clear error) if `isEnabled` is `false`, so callers can safely
  call them and check `isEnabled` to branch.

**New dependency:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### 3.3 Helper: `isS3Library(libraryIdOrObject)`

A utility (can live in `server/utils/storageUtils.js`) that returns `true` when a library has
`storageType === 's3'`. The helper accepts any of:

- A **`Library` model instance** — reads `library.storageType` directly.
- A **`LibraryItem` model instance** — reads `libraryItem.library?.storageType` if the association
  is already loaded, otherwise falls back to a cached lookup by `libraryItem.libraryId`.
- A **library ID string** — looks up the library from the in-memory `Database.libraryModel` cache.

Because `Library` records are small and rarely change, the server should maintain an in-memory
map of `libraryId → storageType` that is refreshed whenever a library is updated. This avoids
a SQL round-trip on every file-serve request. All branching in controllers and managers uses
`isS3Library()` to keep the logic readable.

### 3.4 `server/controllers/SessionController.js` — `getTrack()`

**Current behaviour:** `res.sendFile(audioTrack.metadata.path)` (or X-Accel-Redirect).

**Proposed change:**

```javascript
if (isS3Library(playbackSession.libraryId)) {
  const key = S3StorageManager.buildKey(audioTrack.metadata.relPath, playbackSession.libraryId)
  const url = await S3StorageManager.getPresignedGetUrl(key)
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
| `deleteCover()` | If S3 library → `S3StorageManager.deleteObject(coverKey)` |
| `deleteLibraryItem()` | If S3 library → `S3StorageManager.deleteObjects(allItemKeys)` (list prefix first) |
| `deleteLibraryFile()` | If S3 library → `S3StorageManager.deleteObject(fileKey)` |

### 3.6 `server/controllers/AuthorController.js`

| Method | Change |
|---|---|
| `getImage()` | If S3 library (or globally, since author images are server-managed) → presigned URL redirect using the author image key |
| `deleteImage()` | `S3StorageManager.deleteObject(authorImageKey)` |

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

The resize cache remains local. The source image for resizing comes from S3 for S3-backed
libraries.

**`handleCoverCache(res, libraryItemId, options)`:**

```
1. If cached resized file exists locally → serve it as today (redirect or stream).
2. If not cached:
   a. Get coverPath from DB.
   b. If coverPath is an S3 key (S3 library):
      - Stream from S3 to a local temp file.
      - Resize local temp file into the cache path.
      - Delete the local temp file.
   c. Else (local library):
      - Existing logic: resize directly from coverPath.
3. Redirect or stream the cached file.
```

**`handleAuthorCache`:** Same pattern — source from S3 if author image key is an S3 key.

The key insight is that the cache itself always stays local; only the *source* of truth moves to
S3. Cached resized images do not need to be stored in S3.

### 3.10 `server/finders/AuthorFinder.js` — `saveAuthorImage()`

```javascript
if (S3StorageManager.isEnabled) {
  // download to OS temp dir
  const tmpPath = Path.join(os.tmpdir(), `author-${authorId}-${Date.now()}.jpg`)
  await downloadImageFile(url, tmpPath)
  const key = S3StorageManager.buildKey(`metadata/authors/${authorId}.jpg`)
  await S3StorageManager.putObject(key, fs.createReadStream(tmpPath))
  await fs.unlink(tmpPath)
  return { path: key }
}
// existing local path …
```

### 3.11 `server/managers/PodcastManager.js` — `startPodcastEpisodeDownload()`

```javascript
// After successful ffmpeg download to this.currentDownload.targetPath …
if (isS3Library(this.currentDownload.libraryItem.libraryId)) {
  const key = S3StorageManager.buildKey(this.currentDownload.targetRelPath,
                                        this.currentDownload.libraryItem.libraryId)
  await S3StorageManager.putObject(key, fs.createReadStream(this.currentDownload.targetPath))
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

Add an S3-aware variant:

```javascript
async setDataFromS3Key(key, relPath) {
  const meta = await S3StorageManager.headObject(key)
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
  const prefix = S3StorageManager.buildKey(`library/${library.id}/`)
  const s3Objects = await S3StorageManager.listObjects(prefix)
  fileItems = s3Objects.map(obj => ({
    fullpath: obj.key,
    path: S3StorageManager.keyToRelPath(obj.key).replace(`library/${library.id}/`, ''),
    extension: Path.extname(obj.key),
    deep: obj.key.split('/').length - prefix.split('/').length - 1,
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
- **Option B (polling):** Periodically call `S3StorageManager.listObjects(prefix)` and diff against
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
if (isS3Library(this.libraryId)) {
  const key = S3StorageManager.buildKey(this.audioFile.metadata.relPath, this.libraryId)
  inputPath = await S3StorageManager.getPresignedGetUrl(key, 3600)
}
// ffmpeg -i inputPath …
```

---

## 4. Library Configuration

### 4.1 Creating an S3 Library

When a user creates a new library in the Audiobookshelf UI and selects "S3" as the storage type,
the following information is required in addition to the existing library settings:

- **S3 Key Prefix for this library** — the sub-path within the bucket where this library's media
  files live (e.g. `audiobooks/` or `podcasts/fiction/`). This is stored in the `Library` record.

The global `S3_BUCKET`, `S3_REGION`, and AWS credentials are shared across all S3 libraries. A
library-level prefix allows multiple libraries in the same bucket.

### 4.2 Library Model Changes

```javascript
// New fields on the Library Sequelize model
storageType:    DataTypes.STRING  // 'local' | 's3', default 'local'
s3KeyPrefix:    DataTypes.STRING  // null for local; e.g. 'audiobooks/' for S3
```

---

## 5. Cover Path Storage Convention

Currently `libraryItem.media.coverPath` is an absolute local filesystem path (e.g.
`/config/metadata/items/li_abc/cover.jpg`). For S3 libraries, this field must store the S3 object
key instead (e.g. `metadata/items/li_abc/cover.jpg`).

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
2. User uploads their existing library folder tree to the bucket using the AWS CLI or S3 sync tool:
   `aws s3 sync /audiobooks/ s3://my-bucket/library/lib_id_here/`
3. User uploads the metadata covers and author images:
   `aws s3 sync /config/metadata/items/ s3://my-bucket/metadata/items/`
   `aws s3 sync /config/metadata/authors/ s3://my-bucket/metadata/authors/`
4. User changes the library `storageType` to `s3` and sets the `s3KeyPrefix` in the UI.
5. User triggers a full library re-scan so the server updates `libraryFile.metadata.path` records
   from local paths to S3 keys.

---

## 8. Implementation Phases

### Phase 1 — Foundation

1. Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `package.json`.
2. Implement `server/managers/S3StorageManager.js`.
3. Add `storageType` / `s3KeyPrefix` columns to `Library` model + write the DB migration.
4. Implement `server/utils/storageUtils.js` (`isS3Library`, `isS3Key` helpers).

### Phase 2 — File Serving (read path, highest impact)

5. Update `SessionController.getTrack()` — presigned URL redirect for S3 libraries.
6. Update `LibraryItemController.getFile()`, `downloadFile()`, `getCover()`, `getEbook()`.
7. Update `ShareController.getSharedItemCover()`, `getSharedItemTrack()`.
8. Update `AuthorController.getImage()`.
9. Update `CacheManager.handleCoverCache()` and `handleAuthorCache()` to source images from S3
   when needed (for the resize step), but keep the resize cache on local disk.

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
    to use `S3StorageManager.deleteObject(s)` for S3 libraries.

---

## 9. Files to Create or Modify

### New files

| File | Purpose |
|---|---|
| `server/managers/S3StorageManager.js` | AWS S3 SDK wrapper singleton |
| `server/utils/storageUtils.js` | `isS3Library()`, `isS3Key()` helpers |
| `server/migrations/v2.XX.0-add-library-storage-type.js` | DB migration adding `storageType` and `s3KeyPrefix` to `Libraries` table |

### Modified files

| File | Nature of change |
|---|---|
| `package.json` | Add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| `server/models/Library.js` | Add `storageType`, `s3KeyPrefix` Sequelize fields |
| `server/managers/S3StorageManager.js` | *(new)* |
| `server/managers/CoverManager.js` | S3 branches in all write operations |
| `server/managers/CacheManager.js` | Source cover/author images from S3 when key is S3 key |
| `server/managers/PodcastManager.js` | Upload downloaded episode to S3 |
| `server/managers/AudioMetadataManager.js` | Download-modify-upload for S3 libraries (Phase 6) |
| `server/finders/AuthorFinder.js` | Upload author image to S3 |
| `server/controllers/SessionController.js` | Presigned URL redirect for S3 audio tracks |
| `server/controllers/LibraryItemController.js` | Presigned URL redirect for S3 file/cover/ebook; S3 delete |
| `server/controllers/AuthorController.js` | Presigned URL redirect / S3 delete for author images |
| `server/controllers/ShareController.js` | Presigned URL redirect for shared item track/cover |
| `server/scanner/LibraryScanner.js` | `listObjects` for S3 library folder scan |
| `server/objects/files/LibraryFile.js` | Add `setDataFromS3Key()` method |
| `server/objects/Stream.js` | Presigned URL as ffmpeg input source |
| `server/Watcher.js` | Skip watching for S3 libraries |

---

## 10. Out of Scope

The following are explicitly excluded from this plan, as agreed in the requirements:

- SQLite database — always stored on local disk.
- Application server configuration UI for AWS credentials (credentials come from env vars only).
- S3 support for backup archives (`BackupManager`) — backups cover the database, which stays local.
- HLS transcode segment storage in S3 — segments are ephemeral and always local.
- Resize cache storage in S3 — derived images are always local.
- Direct-to-S3 browser uploads (presigned PUT URLs) — a future optimisation.
- Automatic migration tooling for existing local libraries to S3.
