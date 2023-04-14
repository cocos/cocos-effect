/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import {
	workspace,
	ExtensionContext,
	SemanticTokensLegend,
	DocumentSemanticTokensProvider,
	TextDocument,
	ProviderResult,
	CancellationToken,
	SemanticTokens,
	SemanticTokensBuilder,
	languages,
} from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

const tokenTypes = ['macro', 'keyword', 'enum', 'function', 'variable'];
const tokenModifiers = ['declaration', 'documentation'];
const legend = new SemanticTokensLegend(tokenTypes, tokenModifiers);
const selector = { language: 'cocos-program', scheme: 'file' };

const intrinsic_keywords = [
	"attribute",
	"const",
	"uniform",
	"varying",
	"in",
	"out",
	"inout",
	"float",
	"double",
	"int",
	"void",
	"bool",
	"true",
	"false",
	"if",
	"else",
	"switch",
	"case",
	"default",
	"while",
	"do",
	"for",
	"continue",
	"break",
	"return",
	"discard",
	"mat2",
	"mat3",
	"mat4",
	"vec2",
	"vec3",
	"vec4",
	"ivec2",
	"ivec3",
	"ivec4",
	"bvec2",
	"bvec3",
	"bvec4",
	"sampler1D",
	"sampler2D",
	"sampler3D",
	"samplerCube",
	"sampler1DShadow",
	"sampler2DShadow",
	"struct",
	"invariant",
	"precise",
	"highp",
	"mediump",
	"lowp",
	"precision",
	"asm",
	"class",
	"union",
	"enum",
	"typedef",
	"template",
	"this",
	"packed",
	"goto",
	"inline",
	"noinline",
	"volatile",
	"public",
	"static",
	"extern",
	"external",
	"interface",
	"long",
	"short",
	"half",
	"fixed",
	"unsigned",
	"superp",
	"input",
	"output",
	"hvec2",
	"hvec3",
	"hvec4",
	"fvec2",
	"fvec3",
	"fvec4",
	"sampler2DRect",
	"sampler3DRect",
	"sampler2DRectShadow",
	"sizeof",
	"cast",
	"namespace",
	"using",
];

const extra_keywords = [
	"define",
	"endif",
	"include",
	"pragma",
	"define-meta",
];

interface IParsedToken {
	line: number;
	startCharacter: number;
	length: number;
	tokenType: number;
	tokenModifiers: string[];
}

class CocosSemanticTokensProvider implements DocumentSemanticTokensProvider {
	provideDocumentSemanticTokens(
		document: TextDocument,
		token: CancellationToken
	): ProviderResult<SemanticTokens> {
		const allTokens = this.parseTokens(document);
		const tokensBuilder = new SemanticTokensBuilder(legend);

		allTokens.forEach((token) => {
			tokensBuilder.push(
				token.line,
				token.startCharacter,
				token.length,
				token.tokenType,
			);
		});

		return tokensBuilder.build();
	}

	private extractMacros(precompile: string): { word: string, index: number }[] {
		const wordRegex = /(\w+)/g;
		const res = [];
		let match;
		while ((match = wordRegex.exec(precompile)) !== null) {
			res.push({ word: match[1], index: match.index });
		}
		return res;
	}

	private parseTokens(document: TextDocument): IParsedToken[] {
		const text = document.getText();
		const res = [];
		const functionRegex = /(\w+)\s*\(([^)]*)\)/g;
		const precompileRegex = /^#(.*)$/gm;
		let match;
		while ((match = functionRegex.exec(text)) !== null) {
			if (intrinsic_keywords.includes(match[1])) {
				continue;
			}
			let tokenType = 3;
			if (extra_keywords.includes(match[1])) {
				tokenType = 1;
			}
			res.push({
				line: document.positionAt(match.index).line,
				startCharacter: document.positionAt(match.index).character,
				length: match[1].length,
				tokenType: tokenType,
				tokenModifiers: [],
			});
		}
		while ((match = precompileRegex.exec(text)) !== null) {
			// extract macros in the precompile
			const macros = this.extractMacros(match[1]);
			macros.forEach((macro) => {
				if (intrinsic_keywords.includes(macro.word)) {
					return;
				}
				if (!isNaN(Number(macro.word))) {
					return;
				}
				let tokenType = 0;
				if (extra_keywords.includes(macro.word)) {
					tokenType = 1;
				}
				res.push({
					line: document.positionAt(match.index).line,
					startCharacter: document.positionAt(match.index + macro.index + 1).character,
					length: macro.word.length,
					tokenType: tokenType,
					tokenModifiers: [],
				});
			});
		}
		return res;
	}
}

export function activate(context: ExtensionContext) {
	languages.registerDocumentSemanticTokensProvider(selector, new CocosSemanticTokensProvider(), legend);

	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'cocos-program' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'CocosEffectLanguageServer',
		'Cocos Effect Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
