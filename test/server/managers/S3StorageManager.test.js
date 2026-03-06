const { expect } = require('chai')
const sinon = require('sinon')

/**
 * Tests for S3StorageManager.
 * We stub out the AWS SDK so no real credentials are needed.
 */
describe('S3StorageManager', () => {
  let S3StorageManager
  let S3ClientStub
  let sendStub
  let getSignedUrlStub

  beforeEach(() => {
    // Reset module cache so we can inject stubs
    delete require.cache[require.resolve('../../../server/managers/S3StorageManager')]

    sendStub = sinon.stub().resolves({ Body: null, ContentLength: 1024, LastModified: new Date('2024-01-01') })

    S3ClientStub = sinon.stub().returns({ send: sendStub })

    // Stub the AWS SDK modules
    require('@aws-sdk/client-s3')
    const clientS3Module = require('@aws-sdk/client-s3')
    sinon.stub(clientS3Module, 'S3Client').callsFake(S3ClientStub)

    getSignedUrlStub = sinon.stub().resolves('https://s3.example.com/presigned-url?signature=xxx')
    const presignerModule = require('@aws-sdk/s3-request-presigner')
    sinon.stub(presignerModule, 'getSignedUrl').callsFake(getSignedUrlStub)

    S3StorageManager = require('../../../server/managers/S3StorageManager')
  })

  afterEach(() => {
    sinon.restore()
    delete require.cache[require.resolve('../../../server/managers/S3StorageManager')]
    delete require.cache[require.resolve('@aws-sdk/client-s3')]
    delete require.cache[require.resolve('@aws-sdk/s3-request-presigner')]
  })

  describe('getLibraryClient', () => {
    it('throws if bucket is missing', () => {
      expect(() => S3StorageManager.getLibraryClient({})).to.throw('[S3StorageManager] libraryConfig.bucket is required')
    })

    it('returns an S3LibraryClient instance', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'my-bucket' })
      expect(client).to.be.an('object')
      expect(client.bucket).to.equal('my-bucket')
    })
  })

  describe('S3LibraryClient - key helpers', () => {
    it('buildKey without prefix', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'b' })
      expect(client.buildKey('books/mybook/track.mp3')).to.equal('books/mybook/track.mp3')
    })

    it('buildKey with prefix', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'b', keyPrefix: 'library-1' })
      expect(client.buildKey('books/mybook/track.mp3')).to.equal('library-1/books/mybook/track.mp3')
    })

    it('buildKey strips leading slash from relPath', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'b', keyPrefix: 'lib' })
      expect(client.buildKey('/books/track.mp3')).to.equal('lib/books/track.mp3')
    })

    it('keyToRelPath without prefix', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'b' })
      expect(client.keyToRelPath('books/mybook/track.mp3')).to.equal('books/mybook/track.mp3')
    })

    it('keyToRelPath with prefix', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'b', keyPrefix: 'library-1' })
      expect(client.keyToRelPath('library-1/books/mybook/track.mp3')).to.equal('books/mybook/track.mp3')
    })

    it('keyToRelPath returns key unchanged when prefix does not match', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'b', keyPrefix: 'library-1' })
      expect(client.keyToRelPath('other-lib/books/track.mp3')).to.equal('other-lib/books/track.mp3')
    })

    it('keyPrefix trailing slashes are stripped', () => {
      const client = S3StorageManager.getLibraryClient({ bucket: 'b', keyPrefix: 'library-1//' })
      expect(client.keyPrefix).to.equal('library-1')
      expect(client.buildKey('track.mp3')).to.equal('library-1/track.mp3')
    })
  })

  describe('presignedUrlTtlSeconds', () => {
    it('returns the default TTL', () => {
      expect(S3StorageManager.presignedUrlTtlSeconds).to.be.a('number')
      expect(S3StorageManager.presignedUrlTtlSeconds).to.be.greaterThan(0)
    })
  })
})
