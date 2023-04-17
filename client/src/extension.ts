/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	ExtensionContext,
	languages,
	commands,
	window,
	workspace,
	tasks,
} from 'vscode';

import {
	CocosSemanticTokensProvider, legend, selector,
} from './semantic';

import {
	execFile,
} from 'child_process';

import { CocosEffectContext } from './context';

import * as fs from 'fs';
import * as path from 'path';

function is_engine_path(pth: string): boolean {
	const currentDir = pth;
	if (pth === '' || !fs.existsSync(pth) || !fs.statSync(pth).isDirectory()) {
		return false;
	}
	const pkgJsonPath = path.join(currentDir, 'package.json');
	if (fs.existsSync(pkgJsonPath)) {
		const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
		if (pkgJson.name === 'cocos-creator') {
			return true;
		}
	}
	return false;
}

export async function activate(context: ExtensionContext) {

	// query settings
	const config = workspace.getConfiguration('cocos-effect');
	const pth = config.get<string>('enginePath') || '';

	const enginePath = is_engine_path(pth) ? pth : undefined;
	const compiler_path = path.join(enginePath, 'native', 'external', 'win64', 'bin', 'effect-checker', 'effect-checker.exe');

	const outputChannel = window.createOutputChannel('Cocos Effect');
	context.subscriptions.push(outputChannel);

	const cocosEffectContext = new CocosEffectContext();
	context.subscriptions.push(cocosEffectContext);

	languages.registerDocumentSemanticTokensProvider(selector, new CocosSemanticTokensProvider(), legend);

	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

	context.subscriptions.push(
		commands.registerCommand('CocosEffect.activateLSP', async () => { return; }),
		commands.registerCommand('CocosEffect.restartLSP', async () => {
			if (cocosEffectContext) {
				await cocosEffectContext.dispose();
				window.showInformationMessage('Restarting CocosEffect language server!');
				await cocosEffectContext.activate(serverModule, outputChannel);
			}
		}),
		commands.registerCommand('CocosEffect.compileEffect', async () => {
			const editor = window.activeTextEditor;
			if (editor) {
				if (fs.existsSync(compiler_path)) {
					const terminal = window.activeTerminal || window.createTerminal({ name: 'Cocos Effect', hideFromUser: true });
					const document = editor.document;
					terminal.sendText(`${compiler_path} 0 ${document.fileName} ${enginePath}`);
					terminal.show();
				}
			}
		})
	);

	await cocosEffectContext.activate(serverModule, outputChannel);
}
