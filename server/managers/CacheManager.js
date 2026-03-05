const Path = require('path')
const os = require('os')
const fs = require('../libs/fsExtra')
const stream = require('stream')
const Logger = require('../Logger')
const { resizeImage } = require('../utils/ffmpegHelpers')
const { encodeUriPath } = require('../utils/fileUtils')
const { getLibraryS3Config, isS3Key } = require('../utils/storageUtils')
const S3StorageManager = require('./S3StorageManager')
const Database = require('../Database')

class CacheManager {
  constructor() {
    this.CachePath = null
    this.CoverCachePath = null
    this.ImageCachePath = null
    this.ItemCachePath = null
  }

  /**
   * Create cache directory paths if they dont exist
   */
  async ensureCachePaths() {
    // Creates cache paths if necessary and sets owner and permissions
    this.CachePath = Path.join(global.MetadataPath, 'cache')
    this.CoverCachePath = Path.join(this.CachePath, 'covers')
    this.ImageCachePath = Path.join(this.CachePath, 'images')
    this.ItemCachePath = Path.join(this.CachePath, 'items')

    try {
      await fs.ensureDir(this.CachePath)
      await fs.ensureDir(this.CoverCachePath)
      await fs.ensureDir(this.ImageCachePath)
      await fs.ensureDir(this.ItemCachePath)
    } catch (error) {
      Logger.error(`[CacheManager] Failed to create cache directories at "${this.CachePath}": ${error.message}`)
      throw new Error(`[CacheManager] Failed to create cache directories at "${this.CachePath}"`, { cause: error })
    }
  }

  async handleCoverCache(res, libraryItemId, options = {}) {
    const format = options.format || 'webp'
    const width = options.width || 400
    const height = options.height || null

    res.type(`image/${format}`)

    // Retrieve the cover path from DB to determine if it's an S3 key
    const coverPath = await Database.libraryItemModel.getCoverPath(libraryItemId)

    if (coverPath && isS3Key(coverPath)) {
      // S3-backed library: resize cache lives in S3 under __resize_cache__/
      const s3Config = await this._getS3ConfigForLibraryItem(libraryItemId)
      if (s3Config) {
        return this._handleS3CoverCache(res, libraryItemId, coverPath, s3Config, width, height, format)
      }
    }

    // ---- Local cache logic (unchanged) ----
    const cachePath = Path.join(this.CoverCachePath, `${libraryItemId}_${width}${height ? `x${height}` : ''}`) + '.' + format

    // Cache exists
    if (await fs.pathExists(cachePath)) {
      if (global.XAccel) {
        const encodedURI = encodeUriPath(global.XAccel + cachePath)
        Logger.debug(`Use X-Accel to serve static file ${encodedURI}`)
        return res.status(204).header({ 'X-Accel-Redirect': encodedURI }).send()
      }

      const r = fs.createReadStream(cachePath)
      const ps = new stream.PassThrough()
      stream.pipeline(r, ps, (err) => {
        if (err) {
          console.log(err)
          return res.sendStatus(500)
        }
      })
      return ps.pipe(res)
    }

    // Cached cover does not exist, generate it
    if (!coverPath || !(await fs.pathExists(coverPath))) {
      return res.sendStatus(404)
    }

    const writtenFile = await resizeImage(coverPath, cachePath, width, height)
    if (!writtenFile) return res.sendStatus(500)

    if (global.XAccel) {
      const encodedURI = encodeUriPath(global.XAccel + writtenFile)
      Logger.debug(`Use X-Accel to serve static file ${encodedURI}`)
      return res.status(204).header({ 'X-Accel-Redirect': encodedURI }).send()
    }

    var readStream = fs.createReadStream(writtenFile)
    readStream.pipe(res)
  }

  /**
   * Handle cover cache for an S3-backed library item.
   * Cache is stored in S3 under __resize_cache__/covers/
   *
   * @private
   */
  async _handleS3CoverCache(res, libraryItemId, coverKey, s3Config, width, height, format) {
    const libraryClient = S3StorageManager.getLibraryClient(s3Config)
    const cacheRelKey = `__resize_cache__/covers/${libraryItemId}_${width}${height ? `x${height}` : ''}.${format}`
    const cacheKey = libraryClient.buildKey(cacheRelKey)

    // Check if cache already exists in S3
    const cacheExists = await libraryClient.headObject(cacheKey).catch(() => null)
    if (cacheExists) {
      const url = await libraryClient.getPresignedGetUrl(cacheKey, S3StorageManager.presignedUrlTtlSeconds)
      Logger.debug(`[CacheManager] S3 cache hit for cover ${libraryItemId}`)
      return res.redirect(url)
    }

    // Cache miss: stream source cover from S3 to a temp file, resize it, upload to S3 cache
    const tempSuffix = `abscover_${libraryItemId}_${Date.now()}`
    const tempSourcePath = Path.join(os.tmpdir(), `${tempSuffix}_src`)
    const tempResizedPath = Path.join(os.tmpdir(), `${tempSuffix}_resized.${format}`)

    try {
      // Download source cover to temp file
      const sourceStream = await libraryClient.getObjectStream(coverKey)
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(tempSourcePath)
        sourceStream.pipe(writeStream)
        writeStream.on('finish', resolve)
        writeStream.on('error', reject)
        sourceStream.on('error', reject)
      })

      // Resize
      const writtenFile = await resizeImage(tempSourcePath, tempResizedPath, width, height)
      if (!writtenFile) {
        return res.sendStatus(500)
      }

      // Upload resized image to S3 cache
      const readStream = fs.createReadStream(tempResizedPath)
      await libraryClient.putObject(cacheKey, readStream, `image/${format}`)

      // Redirect to the newly cached presigned URL
      const url = await libraryClient.getPresignedGetUrl(cacheKey, S3StorageManager.presignedUrlTtlSeconds)
      Logger.debug(`[CacheManager] S3 cache miss — resized and uploaded cover ${libraryItemId}`)
      return res.redirect(url)
    } catch (error) {
      Logger.error(`[CacheManager] Failed to handle S3 cover cache for ${libraryItemId}`, error)
      return res.sendStatus(500)
    } finally {
      // Clean up temp files
      fs.unlink(tempSourcePath).catch(() => {})
      fs.unlink(tempResizedPath).catch(() => {})
    }
  }

  /**
   * Resolve S3 config for a library item by looking up its library.
   * @private
   * @param {string} libraryItemId
   * @returns {Promise<{bucket:string,keyPrefix:string,region?:string,endpoint?:string}|null>}
   */
  async _getS3ConfigForLibraryItem(libraryItemId) {
    const libraryItem = await Database.libraryItemModel.findByPk(libraryItemId, {
      attributes: ['id', 'libraryId']
    })
    if (!libraryItem) return null
    return getLibraryS3Config(libraryItem.libraryId)
  }

  /**
   * Purge cover cache for a single library item.
   * For S3-backed libraries, deletes the resize cache objects from S3.
   * @param {string} libraryItemId
   */
  async purgeCoverCache(libraryItemId) {
    // Try to purge from S3 if this is an S3-backed item
    const s3Config = await this._getS3ConfigForLibraryItem(libraryItemId).catch(() => null)
    if (s3Config) {
      const libraryClient = S3StorageManager.getLibraryClient(s3Config)
      const cachePrefix = `__resize_cache__/covers/${libraryItemId}_`
      const objects = await libraryClient.listObjects(cachePrefix).catch((err) => {
        Logger.error(`[CacheManager] Failed to list S3 cache objects for ${libraryItemId}`, err)
        return []
      })
      if (objects.length) {
        await libraryClient.deleteObjects(objects.map((o) => o.key)).catch((err) => {
          Logger.error(`[CacheManager] Failed to delete S3 cache objects for ${libraryItemId}`, err)
        })
      }
    }
    // Also purge local cache (no-op if no local cache files exist)
    return this.purgeEntityCache(libraryItemId, this.CoverCachePath)
  }

  purgeImageCache(entityId) {
    return this.purgeEntityCache(entityId, this.ImageCachePath)
  }

  async purgeEntityCache(entityId, cachePath) {
    if (!entityId || !cachePath) return []
    return Promise.all(
      (await fs.readdir(cachePath)).reduce((promises, file) => {
        if (file.startsWith(entityId)) {
          Logger.debug(`[CacheManager] Going to purge ${file}`)
          promises.push(this.removeCache(Path.join(cachePath, file)))
        }
        return promises
      }, [])
    )
  }

  removeCache(path) {
    if (!path) return false
    return fs.pathExists(path).then((exists) => {
      if (!exists) return false
      return fs
        .unlink(path)
        .then(() => true)
        .catch((err) => {
          Logger.error(`[CacheManager] Failed to remove cache "${path}"`, err)
          return false
        })
    })
  }

  async purgeAll() {
    Logger.info(`[CacheManager] Purging all cache at "${this.CachePath}"`)
    if (await fs.pathExists(this.CachePath)) {
      await fs.remove(this.CachePath).catch((error) => {
        Logger.error(`[CacheManager] Failed to remove cache dir "${this.CachePath}"`, error)
      })
    }
    await this.ensureCachePaths()
  }

  async purgeItems() {
    Logger.info(`[CacheManager] Purging items cache at "${this.ItemCachePath}"`)
    if (await fs.pathExists(this.ItemCachePath)) {
      await fs.remove(this.ItemCachePath).catch((error) => {
        Logger.error(`[CacheManager] Failed to remove items cache dir "${this.ItemCachePath}"`, error)
      })
    }
    await this.ensureCachePaths()
  }

  /**
   *
   * @param {import('express').Response} res
   * @param {String} authorId
   * @param {{ format?: string, width?: number, height?: number }} options
   * @returns
   */
  async handleAuthorCache(res, authorId, options = {}) {
    const format = options.format || 'webp'
    const width = options.width || 400
    const height = options.height || null

    res.type(`image/${format}`)

    var cachePath = Path.join(this.ImageCachePath, `${authorId}_${width}${height ? `x${height}` : ''}`) + '.' + format

    // Cache exists
    if (await fs.pathExists(cachePath)) {
      const r = fs.createReadStream(cachePath)
      const ps = new stream.PassThrough()
      stream.pipeline(r, ps, (err) => {
        if (err) {
          console.log(err)
          return res.sendStatus(500)
        }
      })
      return ps.pipe(res)
    }

    const author = await Database.authorModel.findByPk(authorId)
    if (!author || !author.imagePath || !(await fs.pathExists(author.imagePath))) {
      return res.sendStatus(404)
    }

    let writtenFile = await resizeImage(author.imagePath, cachePath, width, height)
    if (!writtenFile) return res.sendStatus(500)

    var readStream = fs.createReadStream(writtenFile)
    readStream.pipe(res)
  }
}
module.exports = new CacheManager()
