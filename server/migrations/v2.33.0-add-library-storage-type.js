/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface - a sequelize QueryInterface object.
 * @property {import('../Logger')} logger - a Logger object.
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context - an object containing the migration context.
 */

const migrationVersion = '2.33.0'
const migrationName = `${migrationVersion}-add-library-storage-type`
const loggerPrefix = `[${migrationVersion} migration]`

/**
 * This upward migration adds storageType, s3Bucket, s3Region, s3Endpoint, and s3KeyPrefix
 * columns to the libraries table to support optional S3-backed library storage.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)

  const DataTypes = queryInterface.sequelize.Sequelize.DataTypes
  const tableDescription = await queryInterface.describeTable('libraries')

  if (!tableDescription.storageType) {
    logger.info(`${loggerPrefix} Adding column "storageType" to "libraries"`)
    await queryInterface.addColumn('libraries', 'storageType', {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'local'
    })
    logger.info(`${loggerPrefix} Added column "storageType" to "libraries"`)
  } else {
    logger.info(`${loggerPrefix} Column "storageType" already exists in "libraries"`)
  }

  if (!tableDescription.s3Bucket) {
    logger.info(`${loggerPrefix} Adding column "s3Bucket" to "libraries"`)
    await queryInterface.addColumn('libraries', 's3Bucket', {
      type: DataTypes.STRING,
      allowNull: true
    })
    logger.info(`${loggerPrefix} Added column "s3Bucket" to "libraries"`)
  } else {
    logger.info(`${loggerPrefix} Column "s3Bucket" already exists in "libraries"`)
  }

  if (!tableDescription.s3Region) {
    logger.info(`${loggerPrefix} Adding column "s3Region" to "libraries"`)
    await queryInterface.addColumn('libraries', 's3Region', {
      type: DataTypes.STRING,
      allowNull: true
    })
    logger.info(`${loggerPrefix} Added column "s3Region" to "libraries"`)
  } else {
    logger.info(`${loggerPrefix} Column "s3Region" already exists in "libraries"`)
  }

  if (!tableDescription.s3Endpoint) {
    logger.info(`${loggerPrefix} Adding column "s3Endpoint" to "libraries"`)
    await queryInterface.addColumn('libraries', 's3Endpoint', {
      type: DataTypes.STRING,
      allowNull: true
    })
    logger.info(`${loggerPrefix} Added column "s3Endpoint" to "libraries"`)
  } else {
    logger.info(`${loggerPrefix} Column "s3Endpoint" already exists in "libraries"`)
  }

  if (!tableDescription.s3KeyPrefix) {
    logger.info(`${loggerPrefix} Adding column "s3KeyPrefix" to "libraries"`)
    await queryInterface.addColumn('libraries', 's3KeyPrefix', {
      type: DataTypes.STRING,
      allowNull: true
    })
    logger.info(`${loggerPrefix} Added column "s3KeyPrefix" to "libraries"`)
  } else {
    logger.info(`${loggerPrefix} Column "s3KeyPrefix" already exists in "libraries"`)
  }

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * This downward migration removes the storageType, s3Bucket, s3Region, s3Endpoint,
 * and s3KeyPrefix columns from the libraries table.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)

  const tableDescription = await queryInterface.describeTable('libraries')

  for (const column of ['s3KeyPrefix', 's3Endpoint', 's3Region', 's3Bucket', 'storageType']) {
    if (tableDescription[column]) {
      logger.info(`${loggerPrefix} Removing column "${column}" from "libraries"`)
      await queryInterface.removeColumn('libraries', column)
      logger.info(`${loggerPrefix} Removed column "${column}" from "libraries"`)
    } else {
      logger.info(`${loggerPrefix} Column "${column}" does not exist in "libraries"`)
    }
  }

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down }
