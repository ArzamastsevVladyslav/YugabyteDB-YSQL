const {AlterScriptDto} = require('../../types/AlterScriptDto');
const {
    AlterCollectionDto,
    AlterCollectionColumnDto,
    AlterCollectionRoleCompModPKDto,
    AlterCollectionColumnPrimaryKeyOptionDto
} = require('../../types/AlterCollectionDto');

/**
 * @return {(collection: AlterCollectionDto) => boolean}
 * */
const didCompositePkChange = (_) => (collection) => {
    const pkDto = collection?.role?.compMod?.primaryKey || {};
    const newPrimaryKeys = pkDto.new || [];
    const oldPrimaryKeys = pkDto.old || [];
    if (newPrimaryKeys.length !== oldPrimaryKeys.length) {
        return true;
    }
    if (newPrimaryKeys.length === 0 && oldPrimaryKeys.length === 0) {
        return false;
    }
    const areKeyArraysEqual = _(oldPrimaryKeys).differenceWith(newPrimaryKeys, _.isEqual).isEmpty();
    return !areKeyArraysEqual;
}

/**
 * @param entityName {string}
 * @return {string}
 * */
const getDefaultConstraintName = (entityName) => {
    return `${entityName}_pk`;
}

/**
 * @param primaryKey {AlterCollectionRoleCompModPKDto}
 * @param entityName {string}
 * @return {string}
 * */
const getConstraintNameForCompositePk = (primaryKey, entityName) => {
    if (primaryKey.constraintName) {
        return primaryKey.constraintName;
    }
    return getDefaultConstraintName(entityName);
}

/**
 * @param _
 * @return {(
 *      primaryKey: AlterCollectionRoleCompModPKDto,
 *      entityName: string,
 *      entityJsonSchema: AlterCollectionDto,
 * ) => {
 *         name: string,
 *         keyType: string,
 *         columns: Array<{
 *      		isActivated: boolean,
 *      		name: string,
 *  	   }>,
 *         include: Array<{
 *              isActivated: boolean,
 *              name: string,
 *         }>,
 *         storageParameters: string,
 *         tablespace: string,
 *      }
 *  }
 * */
const getCreateCompositePKDDLProviderConfig = (_) => (
    primaryKey,
    entityName,
    entity
) => {
    const constraintName = getConstraintNameForCompositePk(primaryKey, entityName);
    const pkColumns = _.toPairs(entity.role.properties)
        .filter(([name, jsonSchema]) => Boolean(primaryKey.compositePrimaryKey.find(keyDto => keyDto.keyId === jsonSchema.GUID)))
        .map(([name, jsonSchema]) => ({
            name,
            isActivated: jsonSchema.isActivated,
        }));

    let storageParameters = '';
    let indexTablespace = '';
    let includeColumns = [];
    if (primaryKey.indexStorageParameters) {
        storageParameters = primaryKey.indexStorageParameters;
    }
    if (primaryKey.indexTablespace) {
        indexTablespace = primaryKey.indexTablespace;
    }
    if (primaryKey.indexInclude) {
        includeColumns = _.toPairs(entity.role.properties)
            .filter(([name, jsonSchema]) => Boolean(primaryKey.indexInclude.find(keyDto => keyDto.keyId === jsonSchema.GUID)))
            .map(([name, jsonSchema]) => ({
                name,
                isActivated: jsonSchema.isActivated,
            }));
    }

    return {
        name: constraintName,
        keyType: 'PRIMARY KEY',
        columns: pkColumns,
        include: includeColumns,
        storageParameters,
        tablespace: indexTablespace,
    }
}

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getAddCompositePkScripts = (_, ddlProvider) => (collection) => {
    const {
        getFullCollectionName,
        getSchemaOfAlterCollection,
        getEntityName,
    } = require('../../../utils/general')(_);

    const didPkChange = didCompositePkChange(_)(collection);
    if (!didPkChange) {
        return []
    }

    const collectionSchema = getSchemaOfAlterCollection(collection);
    const fullTableName = getFullCollectionName(collectionSchema);
    const entityName = getEntityName(collectionSchema);

    const pkDto = collection?.role?.compMod?.primaryKey || {};
    /**
     * @type {Array<AlterCollectionRoleCompModPKDto>}
     * */
    const newPrimaryKeys = pkDto.new || [];

    return newPrimaryKeys
        .map((newPk) => {
            const ddlConfig = getCreateCompositePKDDLProviderConfig(_)(newPk, entityName, collection);
            return ddlProvider.createKeyConstraint(
                fullTableName,
                collection.isActivated,
                ddlConfig
            );
        })
        .filter(Boolean)
        .map(scriptDto => AlterScriptDto.getInstance([scriptDto.statement], scriptDto.isActivated, false))
        .filter(Boolean);
}

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getDropCompositePkScripts = (_, ddlProvider) => (collection) => {
    const {
        getFullCollectionName,
        getSchemaOfAlterCollection,
        getEntityName,
        wrapInQuotes
    } = require('../../../utils/general')(_);

    const didPkChange = didCompositePkChange(_)(collection);
    if (!didPkChange) {
        return [];
    }

    const collectionSchema = getSchemaOfAlterCollection(collection);
    const fullTableName = getFullCollectionName(collectionSchema);
    const entityName = getEntityName(collectionSchema);

    const pkDto = collection?.role?.compMod?.primaryKey || {};
    /**
     * @type {AlterCollectionRoleCompModPKDto[]}
     * */
    const oldPrimaryKeys = pkDto.old || [];

    return oldPrimaryKeys
        .map((oldPk) => {
            let constraintName = wrapInQuotes(getDefaultConstraintName(entityName));
            if (oldPk.constraintName) {
                constraintName = wrapInQuotes(oldPk.constraintName);
            }
            return ddlProvider.dropPkConstraint(fullTableName, constraintName);
        })
        .map(scriptLine => AlterScriptDto.getInstance([scriptLine], collection.isActivated, true))
        .filter(Boolean);
}

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getModifyCompositePkScripts = (_, ddlProvider) => (collection) => {
    const dropCompositePkScripts = getDropCompositePkScripts(_, ddlProvider)(collection);
    const addCompositePkScripts = getAddCompositePkScripts(_, ddlProvider)(collection);

    return [
        ...dropCompositePkScripts,
        ...addCompositePkScripts,
    ].filter(Boolean);
}

/**
 * @param columnJsonSchema {AlterCollectionColumnDto}
 * @param entityName {string}
 * @return {string}
 * */
const getConstraintNameForRegularPk = (columnJsonSchema, entityName) => {
    const constraintOptions = columnJsonSchema.primaryKeyOptions;
    if (constraintOptions?.length && constraintOptions?.length > 0) {
        /**
         * @type {AlterCollectionColumnPrimaryKeyOptionDto}
         * */
        const constraintOption = constraintOptions[0];
        if (constraintOption.constraintName) {
            return constraintOption.constraintName;
        }
    }
    return getDefaultConstraintName(entityName);
}

/**
 * @param _
 * @return {(
 *      name: string,
 *      columnJsonSchema: AlterCollectionColumnDto,
 *      entityName: string,
 *      entityJsonSchema: AlterCollectionDto,
 * ) => {
 *         name: string,
 *         keyType: string,
 *         columns: Array<{
 *      		isActivated: boolean,
 *      		name: string,
 *  	   }>,
 *         include: Array<{
 *              isActivated: boolean,
 *              name: string,
 *         }>,
 *         storageParameters: string,
 *         tablespace: string,
 *      }
 *  }
 * */
const getCreateRegularPKDDLProviderConfig = (_) => (
    columnName,
    columnJsonSchema,
    entityName,
    entity
) => {
    const constraintName = getConstraintNameForRegularPk(columnJsonSchema, entityName);
    const pkColumns = [{
        name: columnName,
        isActivated: columnJsonSchema.isActivated,
    }];

    let storageParameters = '';
    let indexTablespace = '';
    let includeColumns = [];
    const constraintOptions = columnJsonSchema.primaryKeyOptions;
    if (constraintOptions?.length && constraintOptions?.length > 0) {
        /**
         * @type {AlterCollectionColumnPrimaryKeyOptionDto}
         * */
        const constraintOption = constraintOptions[0];
        if (constraintOption.indexStorageParameters) {
            storageParameters = constraintOption.indexStorageParameters;
        }
        if (constraintOption.indexTablespace) {
            indexTablespace = constraintOption.indexTablespace;
        }
        if (constraintOption.indexInclude) {
            includeColumns = _.toPairs(entity.role.properties)
                .filter(([name, jsonSchema]) => Boolean(constraintOption.indexInclude.find(keyDto => keyDto.keyId === jsonSchema.GUID)))
                .map(([name, jsonSchema]) => ({
                    name,
                    isActivated: jsonSchema.isActivated,
                }));
        }
    }

    return {
        name: constraintName,
        keyType: 'PRIMARY KEY',
        columns: pkColumns,
        include: includeColumns,
        storageParameters,
        tablespace: indexTablespace,
    }
}


/**
 * @return {(columnJsonSchema: AlterCollectionColumnDto, collection: AlterCollectionDto) => boolean}
 * */
const wasFieldChangedToBeARegularPk = (_) => (columnJsonSchema, collection) => {
    const oldName = columnJsonSchema.compMod.oldField.name;

    const isRegularPrimaryKey = columnJsonSchema.primaryKey && !columnJsonSchema.compositePrimaryKey;
    const wasTheFieldAPrimaryKey = Boolean(collection.role.properties[oldName]?.primaryKey);
    return isRegularPrimaryKey && !wasTheFieldAPrimaryKey;
}

/**
 * @return {(columnJsonSchema: AlterCollectionColumnDto, collection: AlterCollectionDto) => boolean}
 * */
const isFieldNoLongerARegularPk = (_) => (columnJsonSchema, collection) => {
    const oldName = columnJsonSchema.compMod.oldField.name;

    const oldJsonSchema = collection.role.properties[oldName];
    const wasTheFieldARegularPrimaryKey = oldJsonSchema?.primaryKey && !oldJsonSchema?.compositePrimaryKey;

    const isNotAPrimaryKey = !columnJsonSchema.primaryKey && !columnJsonSchema.compositePrimaryKey;
    return wasTheFieldARegularPrimaryKey && isNotAPrimaryKey;
}

/**
 * @return {(columnJsonSchema: AlterCollectionColumnDto, collection: AlterCollectionDto) => boolean}
 * */
const wasRegularPkModified = (_) => (columnJsonSchema, collection) => {
    const oldName = columnJsonSchema.compMod.oldField.name;
    const oldJsonSchema = collection.role.properties[oldName];

    const isRegularPrimaryKey = columnJsonSchema.primaryKey && !columnJsonSchema.compositePrimaryKey;
    const wasTheFieldARegularPrimaryKey = oldJsonSchema?.primaryKey && !oldJsonSchema?.compositePrimaryKey;

    if (!(isRegularPrimaryKey && wasTheFieldARegularPrimaryKey)) {
        return false;
    }
    const constraintOptions = columnJsonSchema.primaryKeyOptions;
    const oldConstraintOptions = oldJsonSchema?.primaryKeyOptions;
    const areOptionsEqual = _(oldConstraintOptions).differenceWith(constraintOptions, _.isEqual).isEmpty();
    return !areOptionsEqual;
}

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getAddPkScripts = (_, ddlProvider) => (collection) => {
    const {
        getFullCollectionName,
        getSchemaOfAlterCollection,
        getEntityName,
    } = require('../../../utils/general')(_);

    const collectionSchema = getSchemaOfAlterCollection(collection);
    const fullTableName = getFullCollectionName(collectionSchema);
    const entityName = getEntityName(collectionSchema);

    return _.toPairs(collection.properties)
        .filter(([name, jsonSchema]) => {
            return wasFieldChangedToBeARegularPk(_)(jsonSchema, collection) || wasRegularPkModified(_)(jsonSchema, collection);
        })
        .map(([name, jsonSchema]) => {
            const ddlConfig = getCreateRegularPKDDLProviderConfig(_)(name, jsonSchema, entityName, collection);
            return ddlProvider.createKeyConstraint(
                fullTableName,
                collection.isActivated,
                ddlConfig
            );
        })
        .map(scriptDto => AlterScriptDto.getInstance([scriptDto.statement], scriptDto.isActivated, false))
        .filter(Boolean);
}

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getDropPkScript = (_, ddlProvider) => (collection) => {
    const {
        getFullCollectionName,
        getSchemaOfAlterCollection,
        getEntityName,
        wrapInQuotes
    } = require('../../../utils/general')(_);

    const collectionSchema = getSchemaOfAlterCollection(collection);
    const fullTableName = getFullCollectionName(collectionSchema);
    const entityName = getEntityName(collectionSchema);

    return _.toPairs(collection.properties)
        .filter(([name, jsonSchema]) => {
            return isFieldNoLongerARegularPk(_)(jsonSchema, collection) || wasRegularPkModified(_)(jsonSchema, collection);
        })
        .map(([name, jsonSchema]) => {
            const oldName = jsonSchema.compMod.oldField.name;
            const oldJsonSchema = collection.role.properties[oldName];
            const constraintName = wrapInQuotes(getConstraintNameForRegularPk(oldJsonSchema, entityName));
            return ddlProvider.dropPkConstraint(fullTableName, constraintName);
        })
        .map(scriptLine => AlterScriptDto.getInstance([scriptLine], collection.isActivated, true))
        .filter(Boolean);
}

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getModifyPkScripts = (_, ddlProvider) => (collection) => {
    const dropPkScripts = getDropPkScript(_, ddlProvider)(collection);
    const addPkScripts = getAddPkScripts(_, ddlProvider)(collection);

    return [
        ...dropPkScripts,
        ...addPkScripts,
    ].filter(Boolean);
}

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getModifyPkConstraintsScriptDtos = (_, ddlProvider) => (collection) => {
    const modifyCompositePkScripts = getModifyCompositePkScripts(_, ddlProvider)(collection);
    const modifyPkScripts = getModifyPkScripts(_, ddlProvider)(collection);

    return [
        ...modifyCompositePkScripts,
        ...modifyPkScripts,
    ].filter(Boolean);
}

module.exports = {
    getModifyPkConstraintsScriptDtos,
}
