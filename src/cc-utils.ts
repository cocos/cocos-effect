import {
    CompletionItem,
    CompletionItemKind,
    Hover,
    SignatureHelp,
    TextDocument,
    TextDocumentPositionParams
} from 'vscode-languageserver/node';

import {
    // EffectPrograms,
    DefaultEngineDirectory, documents,
} from './server';
import { URI } from 'vscode-uri';

import {
    find_if_upwards,
    is_engine_path,
    is_project_path,
    get_project_engine_dir,
    chunkCachePath,
} from './file-utils';

import * as fs from 'fs';
import * as path from 'path';
import { Range } from 'vscode-languageserver-textdocument';

/**
 * obtain the engine path for a given document
 * it will
 * 1. set the res to the default engine path
 * 2. search upwards for the engine, if found, set the res to it
 * 3. search upwards for the project, if found, set the res to the engine that the last time the project was opened
 * so that the res will be default engine < parent engine < engine that the last time the project was opened
 **/
export function get_environment_path(document: TextDocument): string {
    const uri = URI.parse(document.uri).fsPath;
    const documentPath = path.dirname(uri);
    const engine = find_if_upwards(documentPath, is_engine_path);
    const project = find_if_upwards(documentPath, is_project_path);
    let engineDir = DefaultEngineDirectory;

    if (engine !== '') {
        engineDir = engine;
    }
    if (project !== '') {
        const engineDts = get_project_engine_dir(project);
        engineDir = find_if_upwards(engineDts, is_engine_path);
    }

    return engineDir;
}

export class EngineCache {
    enginePath = '';
    CompletionItems: CompletionItem[] = [];
    SignatureHelps: Map<string, SignatureHelp> = new Map();
    Hovers: Map<string, Hover> = new Map();
    private _refCount = 0;

    get refCount() {
        return this._refCount;
    }

    public ref() {
        this._refCount++;
    }

    public unref() {
        this._refCount--;
    }

    constructor(enginePath: string, CompletionItems: CompletionItem[] = [], SignatureHelps: Map<string, SignatureHelp> = new Map(), Hovers: Map<string, Hover> = new Map()) {
        this.enginePath = enginePath;
        this.CompletionItems = CompletionItems;
        this.SignatureHelps = SignatureHelps;
        this.Hovers = Hovers;
    }
}

export class DocumentCache {
    uri = '';
    enginePath = '';
    CompletionItems: CompletionItem[] = [];
    SignatureHelps: Map<string, SignatureHelp> = new Map();
    Hovers: Map<string, Hover> = new Map();
    constructor(uri: string, enginePath: string, CompletionItems: CompletionItem[] = [], SignatureHelps: Map<string, SignatureHelp> = new Map(), Hovers: Map<string, Hover> = new Map()) {
        this.uri = uri;
        this.enginePath = enginePath;
        this.CompletionItems = CompletionItems;
        this.SignatureHelps = SignatureHelps;
        this.Hovers = Hovers;
    }
}

class ParsedInfo {
    CompletionItems: CompletionItem[] = [];
    SignatureHelps: Map<string, SignatureHelp> = new Map();
    Hovers: Map<string, Hover> = new Map();
}

export const engineCaches = new Map<string, EngineCache>();
export const documentCaches = new Map<string, DocumentCache>();

// const cocosEffectPrograms: Map<string, EffectPrograms> = new Map();
export const programs: Map<string, ProgramRelations> = new Map();

export const unwindedPrograms: Map<string, string> = new Map(); // the opened program will be cached in this map

/**
 * Load the parsed-effect-info.json file to get the completion items and hovers
 * 
 * @param parsed the path to the parsed-effect-info.json file
 * @returns the completion items and hovers defined in the cache file
 */
export function load_cache_file(parsed: string): ParsedInfo {
    const res = new ParsedInfo();
    const json = JSON.parse(fs.readFileSync(parsed, 'utf8'));

    json.list.forEach((item: any) => {
        const completionItem = CompletionItem.create(item.name);
        completionItem.documentation = item.comment || `Cocos-effect system built-in ${item.usage}.`;
        completionItem.detail = item.type;
        res.Hovers.set(item.name, {
            contents: [
                {
                    language: 'c',
                    value: `${item.type} ${item.name}(${item.args.join(', ')})`
                },
                {
                    language: 'markdown',
                    value: `# comments \n${item.comment || `Cocos-effect system built-in ${item.usage}.`}`
                },
                {
                    language: 'markdown',
                    value: item.file ? `# defined in\n${item.file}: l${item.line}, c${item.column}` : '# intrinsic function'
                }
            ]
        });

        switch (item.usage) {
            case 'function':
                completionItem.detail = `${item.type} ${item.name}(${item.args.join(', ')})`;
                completionItem.kind = CompletionItemKind.Function;
                break;
            case 'keyword':
                completionItem.kind = CompletionItemKind.Keyword;
                res.Hovers.delete(item.name);
                break;
            case 'macro':
                completionItem.kind = CompletionItemKind.Keyword;
                break;
            case 'variable':
                completionItem.kind = CompletionItemKind.Variable;
                break;
            default:
                completionItem.kind = CompletionItemKind.Text;
                res.Hovers.delete(item.name);
                break;
        }
        res.CompletionItems.push(completionItem);
    });

    return res;
}

export class ProgramRelations {
    // start: number;
    // end: number;
    public dependsOn: string[] = []; // can depend on anything
    public dependOnBy: string[] = []; // only by the files opened in the editor
}

/**
 * Unwind the program and cache it in the map.
 * 1. find the #include statement recursively
 * 2. push all included programs into the map
 * 3. replace the #include statement with the program content
 */
const includeRE = /^(.*)#include\s+[<"]([^>"]+)[>"](.*)$/gm;
export async function unWindProgram(text: string): Promise<void> {
    // TODO: if the included chunk is not in the map, we need to load it from the file system manually.
    let header = includeRE.exec(text);
    while (header) {
        const programName = header[2];
        const program = unwindedPrograms.get(programName);
        if (program) {
            // TODO: replace the include statement with the program.
        } else {
            // TODO: if the program is not unwinded, we need to unwind it
        }
        header = includeRE.exec(text);
    }
    return;
}

export function load_engine_programs(): boolean {
    // TODO: load the engine programs from the engine path. if not found, return false, the diagnostics should throw an error.
    return false;
}

/**
 * load cache file from engine path, if path is not valid, do nothing.
 * if the cache map does not contain the engine path, create a new one.
 * if the cache map already contains the engine path, update the cache.
 **/
export function update_engine_cache(engineDir: string): void {
    if (!is_engine_path(engineDir)) {
        return;
    }
    const cached_file = path.join(engineDir, chunkCachePath);
    const parsedInfo = load_cache_file(cached_file);
    const cache = engineCaches.get(engineDir);
    if (cache) {
        cache.CompletionItems = parsedInfo.CompletionItems;
        cache.Hovers = parsedInfo.Hovers;
        cache.SignatureHelps = parsedInfo.SignatureHelps;
    } else {
        const engineCache = new EngineCache(engineDir, parsedInfo.CompletionItems, parsedInfo.SignatureHelps, parsedInfo.Hovers);
        engineCaches.set(engineDir, engineCache);
    }
}

/**
 * get the word at the position of the line using regex
 * 
 * @param text line text
 * @param offset offset of the position
 * @returns 
 */
export function getWordAtPosition(text: string, offset: number): string | undefined {
    const wordRegex = /\w+/g;
    let match;
    while ((match = wordRegex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (start <= offset && offset <= end) {
            return match[0];
        }
    }
}

export function getFunctionRanges(textDocument: TextDocument): Range[] {
    const text = textDocument.getText();
    const functionRegex = /(\S+)\s+(\w+)\s*\(([^)]*)\)\s*\{([^}]*)\}/g;
    let match;
    const ranges: Range[] = [];
    while ((match = functionRegex.exec(text)) !== null) {
        const start = match.index + match[0].indexOf(match[1]);
        const end = start + match[1].length;
        // console.log(`function name: ${match[1]}`);
        ranges.push(
            {
                start: textDocument.positionAt(start),
                end: textDocument.positionAt(end)
            }
        );
    }
    return ranges;
}

export function completionProvider(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
    if (textDocument) {
        const cache = documentCaches.get(textDocument.uri);
        if (!cache) {
            return [];
        }
        const engineCache = engineCaches.get(cache?.enginePath);
        return [cache.CompletionItems, engineCache?.CompletionItems || []].flat();
    }
    return [];
}

export function completionResolver(_item: CompletionItem): CompletionItem {
    return _item;
}

export function hoverProvider(_textDocumentPosition: TextDocumentPositionParams): Hover | undefined {
    const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
    if (textDocument) {
        const cache = documentCaches.get(textDocument.uri);
        if (!cache) {
            return;
        }
        const engineCache = engineCaches.get(cache?.enginePath);
        const text = textDocument.getText();
        const line = text.split('\n')[_textDocumentPosition.position.line];
        const word = getWordAtPosition(line, _textDocumentPosition.position.character);

        if (!word) {
            return;
        }

        let hover = cache.Hovers.get(word);
        if (hover) {
            return hover;
        }

        hover = engineCache?.Hovers.get(word);
        if (hover) {
            return hover;
        }

        return {
            contents: [
                {
                    language: 'c',
                    value: word,
                },]
        };
    }
    return;
}

export function signatureHelpProvider(_textDocumentPosition: TextDocumentPositionParams): SignatureHelp | undefined {
    const textDocument = documents.get(_textDocumentPosition.textDocument.uri);
    if (textDocument) {
        const cache = documentCaches.get(textDocument.uri);
        if (!cache) {
            return;
        }
        const engineCache = engineCaches.get(cache?.enginePath);
        const text = textDocument.getText();
        const line = text.split('\n')[_textDocumentPosition.position.line];
        const word = getWordAtPosition(line, _textDocumentPosition.position.character - 2);

        if (!word) {
            return;
        }

        let signatureHelp = cache.SignatureHelps.get(word);
        if (signatureHelp) {
            return signatureHelp;
        }

        signatureHelp = engineCache?.SignatureHelps.get(word);
        if (signatureHelp) {
            return signatureHelp;
        }
    }
    return;
}