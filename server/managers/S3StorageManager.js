const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const Path = require('path')
const Logger = require('../Logger')

const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 18000 // 5 hours

/**
 * Per-library handle wrapping an S3Client instance.
 * Lightweight: instantiation is cheap; all heavy resources live in the cached S3Client.
 */
class S3LibraryClient {
  /**
   * @param {S3Client} s3Client
   * @param {string} bucket
   * @param {string} keyPrefix - e.g. 'audiobooks/' or '' (no prefix)
   */
  constructor(s3Client, bucket, keyPrefix) {
    this._s3 = s3Client
    this.bucket = bucket
    /** @type {string} - always ends without a trailing slash (empty string when no prefix) */
    this.keyPrefix = keyPrefix ? keyPrefix.replace(/\/+$/, '') : ''
  }

  // ---------------------------------------------------------------------------
  // Key helpers
  // ---------------------------------------------------------------------------

  /**
   * Prepend keyPrefix to a relative path to form an S3 object key.
   * @param {string} relPath
   * @returns {string}
   */
  buildKey(relPath) {
    const normalised = relPath.replace(/^\/+/, '')
    return this.keyPrefix ? `${this.keyPrefix}/${normalised}` : normalised
  }

  /**
   * Strip keyPrefix from an S3 object key to get a relative path.
   * @param {string} key
   * @returns {string}
   */
  keyToRelPath(key) {
    if (this.keyPrefix && key.startsWith(this.keyPrefix + '/')) {
      return key.slice(this.keyPrefix.length + 1)
    }
    return key
  }

  // ---------------------------------------------------------------------------
  // Object lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Upload a stream or buffer to S3.
   * @param {string} key
   * @param {import('stream').Readable|Buffer} body
   * @param {string} [contentType]
   */
  async putObject(key, body, contentType) {
    const params = {
      Bucket: this.bucket,
      Key: key,
      Body: body
    }
    if (contentType) params.ContentType = contentType
    await this._s3.send(new PutObjectCommand(params))
    Logger.debug(`[S3LibraryClient] putObject: s3://${this.bucket}/${key}`)
  }

  /**
   * Get a readable stream for an S3 object.
   * @param {string} key
   * @returns {Promise<import('stream').Readable>}
   */
  async getObjectStream(key) {
    const response = await this._s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return response.Body
  }

  /**
   * Get object metadata.
   * @param {string} key
   * @returns {Promise<{size: number, lastModified: Date}|null>}
   */
  async headObject(key) {
    try {
      const response = await this._s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return {
        size: response.ContentLength,
        lastModified: response.LastModified
      }
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return null
      }
      throw error
    }
  }

  /**
   * Delete a single object.
   * @param {string} key
   */
  async deleteObject(key) {
    await this._s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    Logger.debug(`[S3LibraryClient] deleteObject: s3://${this.bucket}/${key}`)
  }

  /**
   * Batch delete up to 1000 objects per call.
   * @param {string[]} keys
   */
  async deleteObjects(keys) {
    if (!keys || !keys.length) return
    // S3 limits 1000 keys per request
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      const params = {
        Bucket: this.bucket,
        Delete: {
          Objects: batch.map((k) => ({ Key: k })),
          Quiet: true
        }
      }
      await this._s3.send(new DeleteObjectsCommand(params))
      Logger.debug(`[S3LibraryClient] deleteObjects: deleted ${batch.length} objects from s3://${this.bucket}`)
    }
  }

  /**
   * List objects under a prefix.
   * @param {string} prefix - relative prefix within the library (will be prepended with keyPrefix)
   * @returns {Promise<{key: string, size: number, lastModified: Date}[]>}
   */
  async listObjects(prefix) {
    const fullPrefix = prefix ? this.buildKey(prefix) : this.keyPrefix ? this.keyPrefix + '/' : ''
    const results = []
    let continuationToken = undefined

    do {
      const params = {
        Bucket: this.bucket,
        Prefix: fullPrefix,
        ContinuationToken: continuationToken
      }
      const response = await this._s3.send(new ListObjectsV2Command(params))
      if (response.Contents) {
        for (const obj of response.Contents) {
          results.push({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified })
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
    } while (continuationToken)

    return results
  }

  /**
   * Copy an object within the same bucket.
   * @param {string} sourceKey
   * @param {string} destKey
   */
  async copyObject(sourceKey, destKey) {
    await this._s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: destKey
      })
    )
    Logger.debug(`[S3LibraryClient] copyObject: s3://${this.bucket}/${sourceKey} → ${destKey}`)
  }

  // ---------------------------------------------------------------------------
  // Client delivery – presigned URLs
  // ---------------------------------------------------------------------------

  /**
   * Generate a presigned GET URL for direct client delivery.
   * @param {string} key
   * @param {number} [ttlSeconds]
   * @returns {Promise<string>}
   */
  async getPresignedGetUrl(key, ttlSeconds = DEFAULT_PRESIGNED_URL_TTL_SECONDS) {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key })
    return getSignedUrl(this._s3, command, { expiresIn: ttlSeconds })
  }

  /**
   * Generate a presigned PUT URL for direct browser upload.
   * @param {string} key
   * @param {number} [ttlSeconds]
   * @returns {Promise<string>}
   */
  async getPresignedPutUrl(key, ttlSeconds = DEFAULT_PRESIGNED_URL_TTL_SECONDS) {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key })
    return getSignedUrl(this._s3, command, { expiresIn: ttlSeconds })
  }
}

// ---------------------------------------------------------------------------
// S3StorageManager — factory + S3Client cache
// ---------------------------------------------------------------------------

class S3StorageManager {
  constructor() {
    /** @type {Map<string, S3Client>} */
    this._clientCache = new Map()
    /** @type {number} */
    this._presignedUrlTtlSeconds = parseInt(process.env.S3_PRESIGNED_URL_TTL_SECONDS || '', 10) || DEFAULT_PRESIGNED_URL_TTL_SECONDS
  }

  /**
   * Presigned URL TTL in seconds.
   * Reads S3_PRESIGNED_URL_TTL_SECONDS env var; defaults to 18000 (5 hours).
   * @returns {number}
   */
  get presignedUrlTtlSeconds() {
    return this._presignedUrlTtlSeconds
  }

  /**
   * Get (or create) a cached S3Client for a given region+endpoint pair.
   * @param {string|undefined} region
   * @param {string|undefined} endpoint
   * @returns {S3Client}
   */
  _getOrCreateS3Client(region, endpoint) {
    const cacheKey = JSON.stringify({ region: region || null, endpoint: endpoint || null })
    if (this._clientCache.has(cacheKey)) {
      return this._clientCache.get(cacheKey)
    }

    /** @type {import('@aws-sdk/client-s3').S3ClientConfig} */
    const config = {}
    if (region) config.region = region
    if (endpoint) {
      config.endpoint = endpoint
      // Required for path-style access with MinIO/Cloudflare R2/etc.
      config.forcePathStyle = true
    }

    const client = new S3Client(config)
    this._clientCache.set(cacheKey, client)
    Logger.debug(`[S3StorageManager] Created new S3Client for region=${region || 'default'} endpoint=${endpoint || 'aws'}`)
    return client
  }

  /**
   * Return an S3LibraryClient bound to the given library's S3 configuration.
   * @param {{ bucket: string, keyPrefix?: string, region?: string, endpoint?: string }} libraryConfig
   * @returns {S3LibraryClient}
   */
  getLibraryClient(libraryConfig) {
    if (!libraryConfig?.bucket) {
      throw new Error('[S3StorageManager] libraryConfig.bucket is required')
    }
    const { bucket, keyPrefix = '', region, endpoint } = libraryConfig
    const s3Client = this._getOrCreateS3Client(region, endpoint)
    return new S3LibraryClient(s3Client, bucket, keyPrefix)
  }
}

module.exports = new S3StorageManager()
