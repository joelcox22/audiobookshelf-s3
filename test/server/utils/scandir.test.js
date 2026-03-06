const Path = require('path')
const chai = require('chai')
const expect = chai.expect
const scanUtils = require('../../../server/utils/scandir')

describe('scanUtils', async () => {
  it('should properly group files into potential book library items', async () => {
    global.isWin = process.platform === 'win32'
    global.ServerSettings = {
      scannerParseSubtitle: true
    }

    const filePaths = [
      'randomfile.txt', // Should be ignored because it's not a book media file
      'Book1.m4b', // Root single file audiobook
      'Book2/audiofile.m4b',
      'Book2/disk 001/audiofile.m4b',
      'Book2/disk 002/audiofile.m4b',
      'Author/Book3/audiofile.mp3',
      'Author/Book3/Disc 1/audiofile.mp3',
      'Author/Book3/Disc 2/audiofile.mp3',
      'Author/Series/Book4/cover.jpg',
      'Author/Series/Book4/CD1/audiofile.mp3',
      'Author/Series/Book4/CD2/audiofile.mp3',
      'Author/Series2/Book5/deeply/nested/cd 01/audiofile.mp3',
      'Author/Series2/Book5/deeply/nested/cd 02/audiofile.mp3',
      'Author/Series2/Book5/randomfile.js' // Should be ignored because it's not a book media file
    ]

    // Create fileItems to match the format of fileUtils.recurseFiles
    const fileItems = []
    for (const filePath of filePaths) {
      const dirname = Path.dirname(filePath)
      fileItems.push({
        name: Path.basename(filePath),
        reldirpath: dirname === '.' ? '' : dirname,
        extension: Path.extname(filePath),
        deep: filePath.split('/').length - 1
      })
    }

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false)

    expect(libraryItemGrouping).to.deep.equal({
      'Book1.m4b': 'Book1.m4b',
      Book2: ['audiofile.m4b', 'disk 001/audiofile.m4b', 'disk 002/audiofile.m4b'],
      'Author/Book3': ['audiofile.mp3', 'Disc 1/audiofile.mp3', 'Disc 2/audiofile.mp3'],
      'Author/Series/Book4': ['CD1/audiofile.mp3', 'CD2/audiofile.mp3', 'cover.jpg'],
      'Author/Series2/Book5/deeply/nested': ['cd 01/audiofile.mp3', 'cd 02/audiofile.mp3']
    })
  })

  it('should properly group S3 file items that include name and reldirpath derived from key', async () => {
    global.isWin = process.platform === 'win32'
    global.ServerSettings = {
      scannerParseSubtitle: false
    }

    // Simulate the S3 object keys as stored in the bucket (relative to prefix)
    const s3RelPaths = [
      'Author1/Book1/chapter1.mp3',
      'Author1/Book1/chapter2.mp3',
      'Author2/Book2/audiofile.m4b'
    ]

    // Build file items the same way scanS3Library does after the fix
    const fileItems = s3RelPaths.map((relPath) => {
      const dirname = Path.posix.dirname(relPath)
      return {
        name: Path.posix.basename(relPath),
        fullpath: `bucket-name/${relPath}`,
        path: relPath,
        reldirpath: dirname === '.' ? '' : dirname,
        extension: Path.posix.extname(relPath).toLowerCase(),
        deep: relPath.split('/').length - 1
      }
    })

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false)

    expect(libraryItemGrouping).to.deep.equal({
      'Author1/Book1': ['chapter1.mp3', 'chapter2.mp3'],
      'Author2/Book2': ['audiofile.m4b']
    })
  })

  describe('expandS3FlatGroups', () => {
    it('should split a flat directory with multiple audio files into individual items', () => {
      const grouping = {
        audiobooks: ['Book1.m4b', 'Book2.m4b', 'Book3.m4b']
      }
      const result = scanUtils.expandS3FlatGroups(grouping, 'book', false)
      expect(result).to.deep.equal({
        'audiobooks/Book1.m4b': 'audiobooks/Book1.m4b',
        'audiobooks/Book2.m4b': 'audiobooks/Book2.m4b',
        'audiobooks/Book3.m4b': 'audiobooks/Book3.m4b'
      })
    })

    it('should leave a directory with a single audio file unchanged', () => {
      const grouping = {
        'Author/Book1': ['audiofile.m4b']
      }
      const result = scanUtils.expandS3FlatGroups(grouping, 'book', false)
      expect(result).to.deep.equal({
        'Author/Book1': ['audiofile.m4b']
      })
    })

    it('should leave a multi-part book (with CD sub-directories) unchanged', () => {
      const grouping = {
        'Author/Book1': ['CD 1/part1.mp3', 'CD 2/part2.mp3']
      }
      const result = scanUtils.expandS3FlatGroups(grouping, 'book', false)
      expect(result).to.deep.equal({
        'Author/Book1': ['CD 1/part1.mp3', 'CD 2/part2.mp3']
      })
    })

    it('should leave existing root-level single-file items (string values) unchanged', () => {
      const grouping = {
        'Book1.m4b': 'Book1.m4b',
        'Book2.m4b': 'Book2.m4b'
      }
      const result = scanUtils.expandS3FlatGroups(grouping, 'book', false)
      expect(result).to.deep.equal({
        'Book1.m4b': 'Book1.m4b',
        'Book2.m4b': 'Book2.m4b'
      })
    })

    it('should split mixed flat directory (audio + cover) and drop non-media files', () => {
      const grouping = {
        audiobooks: ['Book1.m4b', 'Book2.m4b', 'cover.jpg']
      }
      const result = scanUtils.expandS3FlatGroups(grouping, 'book', false)
      expect(result).to.deep.equal({
        'audiobooks/Book1.m4b': 'audiobooks/Book1.m4b',
        'audiobooks/Book2.m4b': 'audiobooks/Book2.m4b'
      })
    })

    it('should handle multiple directories independently', () => {
      const grouping = {
        // flat genre dir — should be split
        audiobooks: ['Book1.m4b', 'Book2.m4b'],
        // per-book dir with multiple direct audio files — also split (use CD sub-dirs to keep together)
        'Author/Book3': ['chapter1.mp3', 'chapter2.mp3'],
        // single-file dir — should NOT be split
        'Author/Book4': ['Book4.m4b']
      }
      const result = scanUtils.expandS3FlatGroups(grouping, 'book', false)
      expect(result).to.deep.equal({
        'audiobooks/Book1.m4b': 'audiobooks/Book1.m4b',
        'audiobooks/Book2.m4b': 'audiobooks/Book2.m4b',
        'Author/Book3/chapter1.mp3': 'Author/Book3/chapter1.mp3',
        'Author/Book3/chapter2.mp3': 'Author/Book3/chapter2.mp3',
        'Author/Book4': ['Book4.m4b']
      })
    })
  })
})
