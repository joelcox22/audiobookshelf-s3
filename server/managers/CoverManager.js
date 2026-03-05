const fs = require('../libs/fsExtra')
const Path = require('path')
const os = require('os')
const Logger = require('../Logger')
const readChunk = require('../libs/readChunk')
const imageType = require('../libs/imageType')

const globals = require('../utils/globals')
const { downloadImageFile, filePathToPOSIX, checkPathIsFile } = require('../utils/fileUtils')
const { extractCoverArt } = require('../utils/ffmpegHelpers')
const parseEbookMetadata = require('../utils/parsers/parseEbookMetadata')
const { getLibraryS3Config } = require('../utils/storageUtils')
const S3StorageManager = require('../managers/S3StorageManager')

const CacheManager = require('../managers/CacheManager')

class CoverManager {
  constructor() {}

  getCoverDirectory(libraryItem) {
    if (global.ServerSettings.storeCoverWithItem && !libraryItem.isFile) {
      return libraryItem.path
    } else {
      return Path.posix.join(Path.posix.join(global.MetadataPath, 'items'), libraryItem.id)
    }
  }

  /**
   * Build the S3 cover key for a library item.
   * When storeCoverWithItem is true and the item is not a file, the cover goes in the item's
   * own S3 prefix. Otherwise it goes under .abs/metadata/items/{id}/
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('./S3StorageManager').S3LibraryClient} libraryClient
   * @param {string} ext - file extension including dot, e.g. '.jpg'
   * @returns {string} S3 key
   */
  getCoverS3Key(libraryItem, libraryClient, ext) {
    if (global.ServerSettings.storeCoverWithItem && !libraryItem.isFile) {
      return libraryClient.buildKey(`${libraryItem.relPath}/cover${ext}`)
    } else {
      return libraryClient.buildKey(`.abs/metadata/items/${libraryItem.id}/cover${ext}`)
    }
  }

  getFilesInDirectory(dir) {
    try {
      return fs.readdir(dir)
    } catch (error) {
      Logger.error(`[CoverManager] Failed to get files in dir ${dir}`, error)
      return []
    }
  }

  removeFile(filepath) {
    try {
      return fs.pathExists(filepath).then((exists) => {
        if (!exists) Logger.warn(`[CoverManager] Attempting to remove file that does not exist ${filepath}`)
        return exists ? fs.unlink(filepath) : false
      })
    } catch (error) {
      Logger.error(`[CoverManager] Failed to remove file "${filepath}"`, error)
      return false
    }
  }

  // Remove covers that dont have the same filename as the new cover
  async removeOldCovers(dirpath, newCoverExt) {
    var filesInDir = await this.getFilesInDirectory(dirpath)

    const imageExtensions = ['.jpeg', '.jpg', '.png', '.webp', '.jiff']
    for (let i = 0; i < filesInDir.length; i++) {
      var file = filesInDir[i]
      var _extname = Path.extname(file).toLowerCase()
      var _filename = Path.basename(file, _extname).toLowerCase()
      if (_filename === 'cover' && _extname !== newCoverExt && imageExtensions.includes(_extname)) {
        var filepath = Path.join(dirpath, file)
        Logger.debug(`[CoverManager] Removing old cover from metadata "${filepath}"`)
        await this.removeFile(filepath)
      }
    }
  }

  /**
   * Remove old S3 cover objects for a library item (covers with different extension).
   * Lists all .abs/metadata/items/{id}/ objects and deletes those named "cover.*" but not newCoverExt.
   * @param {import('./S3StorageManager').S3LibraryClient} libraryClient
   * @param {string} libraryItemId
   * @param {boolean} storeCoverWithItem
   * @param {string} itemRelPath
   * @param {string} newCoverExt - e.g. '.jpg'
   */
  async removeOldS3Covers(libraryClient, libraryItemId, storeCoverWithItem, itemRelPath, newCoverExt) {
    const imageExtensions = ['.jpeg', '.jpg', '.png', '.webp', '.jiff']
    const prefix = storeCoverWithItem && itemRelPath ? itemRelPath : `.abs/metadata/items/${libraryItemId}`
    const objects = await libraryClient.listObjects(prefix).catch((err) => {
      Logger.error(`[CoverManager] Failed to list S3 objects for cover cleanup`, err)
      return []
    })
    const toDelete = objects
      .filter((o) => {
        const basename = Path.basename(o.key)
        const ext = Path.extname(basename).toLowerCase()
        const filename = Path.basename(basename, ext).toLowerCase()
        return filename === 'cover' && ext !== newCoverExt && imageExtensions.includes(ext)
      })
      .map((o) => o.key)
    if (toDelete.length) {
      await libraryClient.deleteObjects(toDelete).catch((err) => {
        Logger.error(`[CoverManager] Failed to delete old S3 cover objects`, err)
      })
    }
  }

  async checkFileIsValidImage(imagepath, removeOnInvalid = false) {
    const buffer = await readChunk(imagepath, 0, 12)
    const imgType = imageType(buffer)
    if (!imgType) {
      if (removeOnInvalid) await this.removeFile(imagepath)
      return {
        error: 'Invalid image'
      }
    }

    if (!globals.SupportedImageTypes.includes(imgType.ext)) {
      if (removeOnInvalid) await this.removeFile(imagepath)
      return {
        error: `Invalid image type ${imgType.ext} (Supported: ${globals.SupportedImageTypes.join(',')})`
      }
    }
    return imgType
  }

  /**
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {*} coverFile - file object from req.files
   * @returns {Promise<{error:string}|{cover:string}>}
   */
  async uploadCover(libraryItem, coverFile) {
    const extname = Path.extname(coverFile.name.toLowerCase())
    if (!extname || !globals.SupportedImageTypes.includes(extname.slice(1))) {
      return {
        error: `Invalid image type ${extname} (Supported: ${globals.SupportedImageTypes.join(',')})`
      }
    }

    // S3-backed library: upload directly to S3
    const s3Config = getLibraryS3Config(libraryItem.libraryId)
    if (s3Config) {
      const libraryClient = S3StorageManager.getLibraryClient(s3Config)
      const coverKey = this.getCoverS3Key(libraryItem, libraryClient, extname)

      const uploadStream = fs.createReadStream(coverFile.tempFilePath)
      await libraryClient.putObject(coverKey, uploadStream, `image/${extname.slice(1)}`)
      await fs.unlink(coverFile.tempFilePath).catch(() => {})

      await this.removeOldS3Covers(libraryClient, libraryItem.id, global.ServerSettings.storeCoverWithItem && !libraryItem.isFile, libraryItem.relPath, extname)
      await CacheManager.purgeCoverCache(libraryItem.id)

      Logger.info(`[CoverManager] Uploaded libraryItem cover to S3 "${coverKey}" for "${libraryItem.media.title}"`)
      return { cover: coverKey }
    }

    const coverDirPath = this.getCoverDirectory(libraryItem)
    await fs.ensureDir(coverDirPath)

    const coverFullPath = Path.posix.join(coverDirPath, `cover${extname}`)

    // Move cover from temp upload dir to destination
    const success = await coverFile
      .mv(coverFullPath)
      .then(() => true)
      .catch((error) => {
        Logger.error('[CoverManager] Failed to move cover file', coverFullPath, error)
        return false
      })

    if (!success) {
      return {
        error: 'Failed to move cover into destination'
      }
    }

    await this.removeOldCovers(coverDirPath, extname)
    await CacheManager.purgeCoverCache(libraryItem.id)

    Logger.info(`[CoverManager] Uploaded libraryItem cover "${coverFullPath}" for "${libraryItem.media.title}"`)

    return {
      cover: coverFullPath
    }
  }

  /**
   *
   * @param {string} coverPath
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<{error:string}|{cover:string,updated:boolean}>}
   */
  async validateCoverPath(coverPath, libraryItem) {
    // S3-backed libraries do not support user-supplied local cover paths
    const s3Config = getLibraryS3Config(libraryItem.libraryId)
    if (s3Config) {
      Logger.error(`[CoverManager] validateCoverPath is not supported for S3-backed libraries`)
      return {
        error: 'Local cover paths are not supported for S3-backed libraries. Please upload a cover image instead.'
      }
    }

    // Invalid cover path
    if (!coverPath || coverPath.startsWith('http:') || coverPath.startsWith('https:')) {
      Logger.error(`[CoverManager] validate cover path invalid http url "${coverPath}"`)
      return {
        error: 'Invalid cover path'
      }
    }
    coverPath = filePathToPOSIX(coverPath)
    // Cover path already set on media
    if (libraryItem.media.coverPath == coverPath) {
      Logger.debug(`[CoverManager] validate cover path already set "${coverPath}"`)
      return {
        cover: coverPath,
        updated: false
      }
    }

    // Cover path does not exist
    if (!(await fs.pathExists(coverPath))) {
      Logger.error(`[CoverManager] validate cover path does not exist "${coverPath}"`)
      return {
        error: 'Cover path does not exist'
      }
    }

    // Cover path is not a file
    if (!(await checkPathIsFile(coverPath))) {
      Logger.error(`[CoverManager] validate cover path is not a file "${coverPath}"`)
      return {
        error: 'Cover path is not a file'
      }
    }

    // Check valid image at path
    var imgtype = await this.checkFileIsValidImage(coverPath, false)
    if (imgtype.error) {
      return imgtype
    }

    var coverDirPath = this.getCoverDirectory(libraryItem)

    // Cover path is not in correct directory - make a copy
    if (!coverPath.startsWith(coverDirPath)) {
      await fs.ensureDir(coverDirPath)

      var coverFilename = `cover.${imgtype.ext}`
      var newCoverPath = Path.posix.join(coverDirPath, coverFilename)
      Logger.debug(`[CoverManager] validate cover path copy cover from "${coverPath}" to "${newCoverPath}"`)

      var copySuccess = await fs
        .copy(coverPath, newCoverPath, { overwrite: true })
        .then(() => true)
        .catch((error) => {
          Logger.error(`[CoverManager] validate cover path failed to copy cover`, error)
          return false
        })
      if (!copySuccess) {
        return {
          error: 'Failed to copy cover to dir'
        }
      }
      await this.removeOldCovers(coverDirPath, '.' + imgtype.ext)
      Logger.debug(`[CoverManager] cover copy success`)
      coverPath = newCoverPath
    }

    await CacheManager.purgeCoverCache(libraryItem.id)

    return {
      cover: coverPath,
      updated: true
    }
  }

  /**
   * Extract cover art from audio file and save for library item
   *
   * @param {import('../models/Book').AudioFileObject[]} audioFiles
   * @param {string} libraryItemId
   * @param {string} [libraryItemPath] null for isFile library items
   * @param {string} [libraryId] needed for S3 lookup
   * @returns {Promise<string>} returns cover path or S3 key
   */
  async saveEmbeddedCoverArt(audioFiles, libraryItemId, libraryItemPath, libraryId) {
    let audioFileWithCover = audioFiles.find((af) => af.embeddedCoverArt)
    if (!audioFileWithCover) return null

    // S3-backed library: extract to temp, upload to S3
    const s3Config = libraryId ? getLibraryS3Config(libraryId) : null
    if (s3Config) {
      const libraryClient = S3StorageManager.getLibraryClient(s3Config)
      const ext = audioFileWithCover.embeddedCoverArt === 'png' ? '.png' : '.jpg'
      const tempPath = Path.join(os.tmpdir(), `absembedcover_${libraryItemId}_${Date.now()}${ext}`)

      // For S3, the audio file path is the S3 key — we need to get the actual audio from S3
      // extractCoverArt calls ffmpeg which only works on local files; we skip if key-only
      // Instead we just note that for S3 libraries embedded cover extraction is not available without temp download
      // For now, skip if the audio file metadata.path is an S3 key (no leading /)
      const audioPath = audioFileWithCover.metadata.path
      if (!audioPath || !audioPath.startsWith('/')) {
        Logger.warn(`[CoverManager] Skipping embedded cover extraction for S3-backed audio file (requires local file)`)
        return null
      }

      const success = await extractCoverArt(audioPath, tempPath)
      if (!success) return null

      const coverKey = libraryItemPath
        ? libraryClient.buildKey(`${libraryItemPath}/cover${ext}`)
        : libraryClient.buildKey(`.abs/metadata/items/${libraryItemId}/cover${ext}`)

      const readStream = fs.createReadStream(tempPath)
      await libraryClient.putObject(coverKey, readStream, `image/${ext.slice(1)}`)
      await fs.unlink(tempPath).catch(() => {})
      await CacheManager.purgeCoverCache(libraryItemId)
      return coverKey
    }

    let coverDirPath = null
    if (global.ServerSettings.storeCoverWithItem && libraryItemPath) {
      coverDirPath = libraryItemPath
    } else {
      coverDirPath = Path.posix.join(global.MetadataPath, 'items', libraryItemId)
    }
    await fs.ensureDir(coverDirPath)

    const coverFilename = audioFileWithCover.embeddedCoverArt === 'png' ? 'cover.png' : 'cover.jpg'
    const coverFilePath = Path.join(coverDirPath, coverFilename)

    const coverAlreadyExists = await fs.pathExists(coverFilePath)
    if (coverAlreadyExists) {
      Logger.warn(`[CoverManager] Extract embedded cover art but cover already exists for "${coverFilePath}" - bail`)
      return null
    }

    const success = await extractCoverArt(audioFileWithCover.metadata.path, coverFilePath)
    if (success) {
      await CacheManager.purgeCoverCache(libraryItemId)
      return coverFilePath
    }
    return null
  }

  /**
   * Extract cover art from ebook and save for library item
   *
   * @param {import('../utils/parsers/parseEbookMetadata').EBookFileScanData} ebookFileScanData
   * @param {string} libraryItemId
   * @param {string} [libraryItemPath] null for isFile library items
   * @param {string} [libraryId] needed for S3 lookup
   * @returns {Promise<string>} returns cover path or S3 key
   */
  async saveEbookCoverArt(ebookFileScanData, libraryItemId, libraryItemPath, libraryId) {
    if (!ebookFileScanData?.ebookCoverPath) return null

    let extname = Path.extname(ebookFileScanData.ebookCoverPath) || '.jpg'
    if (extname === '.jpeg') extname = '.jpg'

    // S3-backed library: extract to temp, upload to S3
    const s3Config = libraryId ? getLibraryS3Config(libraryId) : null
    if (s3Config) {
      const libraryClient = S3StorageManager.getLibraryClient(s3Config)
      const tempPath = Path.join(os.tmpdir(), `absebookcover_${libraryItemId}_${Date.now()}${extname}`)

      const success = await parseEbookMetadata.extractCoverImage(ebookFileScanData, tempPath)
      if (!success) return null

      const coverKey = libraryItemPath
        ? libraryClient.buildKey(`${libraryItemPath}/cover${extname}`)
        : libraryClient.buildKey(`.abs/metadata/items/${libraryItemId}/cover${extname}`)

      const readStream = fs.createReadStream(tempPath)
      await libraryClient.putObject(coverKey, readStream, `image/${extname.slice(1)}`)
      await fs.unlink(tempPath).catch(() => {})
      await CacheManager.purgeCoverCache(libraryItemId)
      return coverKey
    }

    let coverDirPath = null
    if (global.ServerSettings.storeCoverWithItem && libraryItemPath) {
      coverDirPath = libraryItemPath
    } else {
      coverDirPath = Path.posix.join(global.MetadataPath, 'items', libraryItemId)
    }
    await fs.ensureDir(coverDirPath)

    const coverFilename = `cover${extname}`
    const coverFilePath = Path.join(coverDirPath, coverFilename)

    // TODO: Overwrite if exists?
    const coverAlreadyExists = await fs.pathExists(coverFilePath)
    if (coverAlreadyExists) {
      Logger.warn(`[CoverManager] Extract embedded cover art but cover already exists for "${coverFilePath}" - overwriting`)
    }

    const success = await parseEbookMetadata.extractCoverImage(ebookFileScanData, coverFilePath)
    if (success) {
      await CacheManager.purgeCoverCache(libraryItemId)
      return coverFilePath
    }
    return null
  }

  /**
   *
   * @param {string} url
   * @param {string} libraryItemId
   * @param {string} [libraryItemPath] - null if library item isFile
   * @param {boolean} [forceLibraryItemFolder=false] - force save cover with library item (used for adding new podcasts)
   * @param {string} [libraryId] - needed for S3 lookup
   * @returns {Promise<{error:string}|{cover:string}>}
   */
  async downloadCoverFromUrlNew(url, libraryItemId, libraryItemPath, forceLibraryItemFolder = false, libraryId) {
    try {
      // S3-backed library: download to temp dir, validate, upload to S3
      const s3Config = libraryId ? getLibraryS3Config(libraryId) : null
      if (s3Config) {
        const libraryClient = S3StorageManager.getLibraryClient(s3Config)
        const temppath = Path.join(os.tmpdir(), `abscover_${libraryItemId}_${Date.now()}`)
        const success = await downloadImageFile(url, temppath)
          .then(() => true)
          .catch((err) => {
            Logger.error(`[CoverManager] Download image file failed for "${url}"`, err)
            return false
          })
        if (!success) {
          return { error: 'Failed to download image from url' }
        }

        const imgtype = await this.checkFileIsValidImage(temppath, true)
        if (imgtype.error) {
          return imgtype
        }

        const ext = `.${imgtype.ext}`
        const coverKey =
          (global.ServerSettings.storeCoverWithItem || forceLibraryItemFolder) && libraryItemPath
            ? libraryClient.buildKey(`${libraryItemPath}/cover${ext}`)
            : libraryClient.buildKey(`.abs/metadata/items/${libraryItemId}/cover${ext}`)

        const readStream = fs.createReadStream(temppath)
        await libraryClient.putObject(coverKey, readStream, `image/${imgtype.ext}`)
        await fs.unlink(temppath).catch(() => {})

        await this.removeOldS3Covers(libraryClient, libraryItemId, (global.ServerSettings.storeCoverWithItem || forceLibraryItemFolder) && !!libraryItemPath, libraryItemPath, ext)
        await CacheManager.purgeCoverCache(libraryItemId)

        Logger.info(`[CoverManager] Downloaded libraryItem cover to S3 "${coverKey}" from url "${url}"`)
        return { cover: coverKey }
      }

      let coverDirPath = null
      if ((global.ServerSettings.storeCoverWithItem || forceLibraryItemFolder) && libraryItemPath) {
        coverDirPath = libraryItemPath
      } else {
        coverDirPath = Path.posix.join(global.MetadataPath, 'items', libraryItemId)
      }

      await fs.ensureDir(coverDirPath)

      const temppath = Path.posix.join(coverDirPath, 'cover')
      const success = await downloadImageFile(url, temppath)
        .then(() => true)
        .catch((err) => {
          Logger.error(`[CoverManager] Download image file failed for "${url}"`, err)
          return false
        })
      if (!success) {
        return {
          error: 'Failed to download image from url'
        }
      }

      const imgtype = await this.checkFileIsValidImage(temppath, true)
      if (imgtype.error) {
        return imgtype
      }

      const coverFullPath = Path.posix.join(coverDirPath, `cover.${imgtype.ext}`)
      await fs.rename(temppath, coverFullPath)

      await this.removeOldCovers(coverDirPath, '.' + imgtype.ext)
      await CacheManager.purgeCoverCache(libraryItemId)

      Logger.info(`[CoverManager] Downloaded libraryItem cover "${coverFullPath}" from url "${url}"`)
      return {
        cover: coverFullPath
      }
    } catch (error) {
      Logger.error(`[CoverManager] Fetch cover image from url "${url}" failed`, error)
      return {
        error: 'Failed to fetch image from url'
      }
    }
  }
}
module.exports = new CoverManager()
