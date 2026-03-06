/**
 * Storage utility helpers for S3/local branching logic.
 *
 * Rather than querying the database on every file-serve request, the server
 * maintains a small in-memory cache of per-library storage configuration.
 * Call `refreshLibraryCache(library)` whenever a library is created or updated.
 */

/**
 * @typedef {Object} LibraryStorageConfig
 * @property {string} storageType - 'local' | 's3'
 * @property {string|null} s3Bucket
 * @property {string|null} s3KeyPrefix
 * @property {string|null} s3Region
 * @property {string|null} s3Endpoint
 */

/** @type {Map<string, LibraryStorageConfig>} */
const libraryConfigCache = new Map()

/**
 * Update the in-memory cache for a single library.
 * Call this whenever a library is created, updated, or deleted.
 *
 * @param {import('../models/Library')} library
 */
function refreshLibraryCache(library) {
  if (!library?.id) return
  libraryConfigCache.set(library.id, {
    storageType: library.storageType || 'local',
    s3Bucket: library.s3Bucket || null,
    s3KeyPrefix: library.s3KeyPrefix || null,
    s3Region: library.s3Region || null,
    s3Endpoint: library.s3Endpoint || null
  })
}

/**
 * Remove a library from the in-memory cache.
 * @param {string} libraryId
 */
function removeLibraryFromCache(libraryId) {
  libraryConfigCache.delete(libraryId)
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the library identified by `libraryIdOrObject` has storageType === 's3'.
 *
 * Accepts:
 *  - A Library model instance
 *  - A LibraryItem model instance (reads libraryItem.library?.storageType if loaded,
 *    otherwise falls back to the in-memory cache by libraryItem.libraryId)
 *  - A library ID string
 *
 * @param {import('../models/Library')|import('../models/LibraryItem')|string} libraryIdOrObject
 * @returns {boolean}
 */
function isS3Library(libraryIdOrObject) {
  if (!libraryIdOrObject) return false

  // Library model instance
  if (typeof libraryIdOrObject === 'object' && 'storageType' in libraryIdOrObject) {
    return libraryIdOrObject.storageType === 's3'
  }

  // LibraryItem model instance — try the association first, then the cache
  if (typeof libraryIdOrObject === 'object' && 'libraryId' in libraryIdOrObject) {
    if (libraryIdOrObject.library?.storageType) {
      return libraryIdOrObject.library.storageType === 's3'
    }
    const cached = libraryConfigCache.get(libraryIdOrObject.libraryId)
    return cached?.storageType === 's3'
  }

  // Library ID string
  if (typeof libraryIdOrObject === 'string') {
    const cached = libraryConfigCache.get(libraryIdOrObject)
    return cached?.storageType === 's3'
  }

  return false
}

/**
 * Return the S3 configuration object for an S3-backed library, or null for local libraries.
 * Accepts the same argument forms as `isS3Library`.
 *
 * @param {import('../models/Library')|import('../models/LibraryItem')|string} libraryIdOrObject
 * @returns {{ bucket: string, keyPrefix: string, region?: string, endpoint?: string }|null}
 */
function getLibraryS3Config(libraryIdOrObject) {
  if (!libraryIdOrObject) return null

  // Library model instance with s3Config getter
  if (typeof libraryIdOrObject === 'object' && typeof libraryIdOrObject.s3Config !== 'undefined') {
    return libraryIdOrObject.s3Config
  }

  // LibraryItem model instance
  if (typeof libraryIdOrObject === 'object' && 'libraryId' in libraryIdOrObject) {
    if (libraryIdOrObject.library) {
      return libraryIdOrObject.library.s3Config ?? null
    }
    const cached = libraryConfigCache.get(libraryIdOrObject.libraryId)
    return _cachedConfigToS3Config(cached)
  }

  // Library ID string
  if (typeof libraryIdOrObject === 'string') {
    const cached = libraryConfigCache.get(libraryIdOrObject)
    return _cachedConfigToS3Config(cached)
  }

  return null
}

/**
 * @param {LibraryStorageConfig|undefined} cached
 * @returns {{ bucket: string, keyPrefix: string, region?: string, endpoint?: string }|null}
 */
function _cachedConfigToS3Config(cached) {
  if (!cached || cached.storageType !== 's3') return null
  return {
    bucket: cached.s3Bucket,
    keyPrefix: cached.s3KeyPrefix || '',
    region: cached.s3Region || undefined,
    endpoint: cached.s3Endpoint || undefined
  }
}

/**
 * Return true if the given path is an S3 object key rather than a local filesystem path.
 * Local paths always start with '/' (POSIX) or a drive letter (Windows).
 * S3 keys never start with '/' and never contain '://'.
 *
 * @param {string|null|undefined} path
 * @returns {boolean}
 */
function isS3Key(path) {
  if (!path) return false
  return !path.startsWith('/') && !path.includes('://')
}

module.exports = {
  refreshLibraryCache,
  removeLibraryFromCache,
  isS3Library,
  getLibraryS3Config,
  isS3Key
}
