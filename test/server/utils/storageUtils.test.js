const { expect } = require('chai')
const storageUtils = require('../../../server/utils/storageUtils')

describe('storageUtils', () => {
  const { refreshLibraryCache, removeLibraryFromCache, isS3Library, getLibraryS3Config, isS3Key } = storageUtils

  afterEach(() => {
    // Clean up cache entries created by tests
    removeLibraryFromCache('test-lib-1')
    removeLibraryFromCache('test-lib-2')
    removeLibraryFromCache('s3-lib')
    removeLibraryFromCache('local-lib')
  })

  // ---------------------------------------------------------------------------
  // isS3Key
  // ---------------------------------------------------------------------------
  describe('isS3Key', () => {
    it('returns false for null/undefined', () => {
      expect(isS3Key(null)).to.be.false
      expect(isS3Key(undefined)).to.be.false
      expect(isS3Key('')).to.be.false
    })

    it('returns false for absolute local paths', () => {
      expect(isS3Key('/mnt/data/audiobooks/book.mp3')).to.be.false
      expect(isS3Key('/home/user/cover.jpg')).to.be.false
    })

    it('returns false for http/https URLs', () => {
      expect(isS3Key('https://example.com/cover.jpg')).to.be.false
      expect(isS3Key('http://cdn.example.com/file.mp3')).to.be.false
    })

    it('returns true for relative S3 keys', () => {
      expect(isS3Key('my-prefix/audiobooks/book/cover.jpg')).to.be.true
      expect(isS3Key('audiobooks/cover.jpg')).to.be.true
      expect(isS3Key('cover.jpg')).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // refreshLibraryCache / removeLibraryFromCache
  // ---------------------------------------------------------------------------
  describe('refreshLibraryCache', () => {
    it('stores local library config', () => {
      refreshLibraryCache({ id: 'local-lib', storageType: 'local' })
      expect(isS3Library('local-lib')).to.be.false
      expect(getLibraryS3Config('local-lib')).to.be.null
    })

    it('stores S3 library config', () => {
      refreshLibraryCache({
        id: 's3-lib',
        storageType: 's3',
        s3Bucket: 'my-bucket',
        s3KeyPrefix: 'prefix',
        s3Region: 'us-east-1',
        s3Endpoint: null
      })
      expect(isS3Library('s3-lib')).to.be.true
      const config = getLibraryS3Config('s3-lib')
      expect(config).to.deep.equal({
        bucket: 'my-bucket',
        keyPrefix: 'prefix',
        region: 'us-east-1',
        endpoint: undefined
      })
    })

    it('does nothing for null input', () => {
      expect(() => refreshLibraryCache(null)).to.not.throw()
    })
  })

  describe('removeLibraryFromCache', () => {
    it('removes library from cache', () => {
      refreshLibraryCache({ id: 's3-lib', storageType: 's3', s3Bucket: 'b', s3KeyPrefix: '', s3Region: null, s3Endpoint: null })
      expect(isS3Library('s3-lib')).to.be.true
      removeLibraryFromCache('s3-lib')
      expect(isS3Library('s3-lib')).to.be.false
    })
  })

  // ---------------------------------------------------------------------------
  // isS3Library
  // ---------------------------------------------------------------------------
  describe('isS3Library', () => {
    it('returns false for null/undefined', () => {
      expect(isS3Library(null)).to.be.false
      expect(isS3Library(undefined)).to.be.false
    })

    it('accepts Library model instance with storageType property', () => {
      expect(isS3Library({ storageType: 's3' })).to.be.true
      expect(isS3Library({ storageType: 'local' })).to.be.false
    })

    it('accepts LibraryItem model instance with libraryId', () => {
      refreshLibraryCache({ id: 's3-lib', storageType: 's3', s3Bucket: 'b', s3KeyPrefix: '', s3Region: null, s3Endpoint: null })
      expect(isS3Library({ libraryId: 's3-lib' })).to.be.true
      expect(isS3Library({ libraryId: 'unknown-lib' })).to.be.false
    })

    it('accepts LibraryItem with loaded library association', () => {
      expect(isS3Library({ libraryId: 'any', library: { storageType: 's3' } })).to.be.true
      expect(isS3Library({ libraryId: 'any', library: { storageType: 'local' } })).to.be.false
    })

    it('accepts a library ID string', () => {
      refreshLibraryCache({ id: 'test-lib-1', storageType: 'local' })
      refreshLibraryCache({ id: 'test-lib-2', storageType: 's3', s3Bucket: 'b', s3KeyPrefix: '', s3Region: null, s3Endpoint: null })
      expect(isS3Library('test-lib-1')).to.be.false
      expect(isS3Library('test-lib-2')).to.be.true
    })
  })

  // ---------------------------------------------------------------------------
  // getLibraryS3Config
  // ---------------------------------------------------------------------------
  describe('getLibraryS3Config', () => {
    it('returns null for local library', () => {
      refreshLibraryCache({ id: 'local-lib', storageType: 'local' })
      expect(getLibraryS3Config('local-lib')).to.be.null
    })

    it('returns config for S3 library by ID', () => {
      refreshLibraryCache({ id: 's3-lib', storageType: 's3', s3Bucket: 'my-bucket', s3KeyPrefix: 'lib/', s3Region: 'eu-west-1', s3Endpoint: 'https://minio.example.com' })
      const config = getLibraryS3Config('s3-lib')
      expect(config.bucket).to.equal('my-bucket')
      expect(config.keyPrefix).to.equal('lib/')
      expect(config.region).to.equal('eu-west-1')
      expect(config.endpoint).to.equal('https://minio.example.com')
    })

    it('uses Library model s3Config getter when available', () => {
      const fakeLibrary = {
        storageType: 's3',
        s3Config: { bucket: 'direct-bucket', keyPrefix: '', region: 'us-east-1', endpoint: undefined }
      }
      const config = getLibraryS3Config(fakeLibrary)
      expect(config.bucket).to.equal('direct-bucket')
    })

    it('returns null for unknown library ID', () => {
      expect(getLibraryS3Config('nonexistent-lib')).to.be.null
    })
  })
})
