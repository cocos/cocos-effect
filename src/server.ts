/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    TextDocumentSyncKind,
    InitializeResult,
} from 'vscode-languageserver/node';

import {
    TextDocument,
} from 'vscode-languageserver-textdocument';

import {
    find_if_upwards,
    is_engine_path,
    is_cocos_creator_path,
    get_creator_engine_path,
    is_project_path,
    get_project_engine_dir,
} from './file-utils';

import {
    DocumentCache,
    documentCaches,
    engineCaches,
    ProgramRelations,
    get_environment_path,
    programs,
    update_engine_cache,
    getWordAtPosition,
    signatureHelpProvider,
    hoverProvider,
    completionResolver,
    completionProvider,
} from './cc-utils';

export let DefaultEngineDirectory = '';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// The example settings
interface CocosEffectLanguageServerSettings {
    maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: CocosEffectLanguageServerSettings = { maxNumberOfProblems: 1000 };
let globalSettings: CocosEffectLanguageServerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<CocosEffectLanguageServerSettings>> = new Map();

function getDocumentSettings(resource: string): Thenable<CocosEffectLanguageServerSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'cocos-effect.languageServer'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
        // query the engine path
    } else {
        globalSettings = <CocosEffectLanguageServerSettings>(
            (change.settings['cocos-effect'].languageServer || defaultSettings)
        );
    }
});

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            /**
             * TODO: disabled temporarily
             */
            // completionProvider: {
            //     resolveProvider: true
            // },
            hoverProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['(',]
            },
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            console.log('Workspace folder change event received.');
        });
    }
    if (hasConfigurationCapability) {
        connection.workspace.getConfiguration({
            section: 'cocos-effect'
        }).then((settings) => {
            if (is_engine_path(settings.enginePath)) {
                DefaultEngineDirectory = settings.enginePath;
                update_engine_cache(settings.enginePath);
                const cache = engineCaches.get(settings.enginePath);
                documentCaches.forEach((value, key) => {
                    if (value.enginePath === '') {
                        value.enginePath = DefaultEngineDirectory;
                        cache?.ref();
                        return;
                    }
                });
            } else if (is_cocos_creator_path(settings.enginePath)) {
                DefaultEngineDirectory = get_creator_engine_path(settings.enginePath);
                update_engine_cache(DefaultEngineDirectory);
                const cache = engineCaches.get(DefaultEngineDirectory);
                documentCaches.forEach((value, key) => {
                    if (value.enginePath === '') {
                        value.enginePath = DefaultEngineDirectory;
                        cache?.ref();
                        return;
                    }
                });
            } else {
                connection.window.showWarningMessage(`Not a valid engine path, ${settings.enginePath}`);
            }
        });
    }
});

documents.onDidOpen(e => {
    const textDocument = e.document;
    const engineDir = get_environment_path(textDocument);
    // priority: default engine path < parent engine path < engine path in the project
    documentCaches.set(textDocument.uri, new DocumentCache(textDocument.uri, engineDir));
    if (!engineCaches.has(engineDir)) {
        update_engine_cache(engineDir);
    }
    engineCaches.get(engineDir)?.ref();

    const fileRelation = programs.get(textDocument.uri);
    if (fileRelation) {
        programs.delete(textDocument.uri);
        console.log('an file already opened');
    }
    programs.set(textDocument.uri, new ProgramRelations());
});

// Only keep settings for open documents
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
    // unlink file relations from the relation map
    const fileRelation = programs.get(e.document.uri);
    if (fileRelation) {
        // remove all dependOn relations
        for (const dependOn of fileRelation.dependsOn) {
            const dependOnRelation = programs.get(dependOn);
            if (dependOnRelation) {
                const index = dependOnRelation.dependOnBy.indexOf(e.document.uri);
                dependOnRelation.dependOnBy.splice(index, 1);
            }
        }
        if (fileRelation.dependOnBy.length === 0) {
            programs.delete(e.document.uri);
        }
    }
    // remove cache
    const cache = documentCaches.get(e.document.uri);
    if (cache) {
        const engineCache = engineCaches.get(cache.enginePath);
        if (engineCache) {
            engineCache.unref();
            if (engineCache.refCount === 0) {
                engineCaches.delete(cache.enginePath);
            }
        }
        documentCaches.delete(e.document.uri);
    }
});

// documents.onDidChangeContent(change => {
// 	const document = change.document;
// 	// TODO: we need to check if the changed position is a include statement or not
// });

// documents.onDidSave(change => {
// 	// unwind to obtain the relations
// 	// unWindProgram(change.document.getText());
// });

// connection.onDidChangeWatchedFiles(_change => {
// 	// 
// });


/**
 * TODO: disabled temporarily
 * The following 2 lines are for completion, they are disabled to make the word based completion work again.
 */
// connection.onCompletion(completionProvider);
// connection.onCompletionResolve(completionResolver);

connection.onHover(hoverProvider);

connection.onSignatureHelp(signatureHelpProvider);

documents.listen(connection);

connection.listen();