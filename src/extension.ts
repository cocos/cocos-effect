import {
	ExtensionContext,
	languages,
	commands,
	window,
	workspace,
} from 'vscode';

import {
	CocosSemanticTokensProvider, legend, selector,
} from './semantic';

import {
	find_if_upwards,
	is_engine_path,
	is_project_path,
	get_project_engine_dir,
	compilerExecPath,
} from './file-utils';

import { CocosEffectContext } from './context';

import * as fs from 'fs';
import * as path from 'path';

export async function activate(context: ExtensionContext) {
	// query settings
	const config = workspace.getConfiguration('cocos-effect');
	const pth = config.get<string>('enginePath') || '';
	const enginePath = is_engine_path(pth) ? pth : undefined;

	const outputChannel = window.createOutputChannel('Cocos Effect');
	context.subscriptions.push(outputChannel);

	const cocosEffectContext = new CocosEffectContext();
	context.subscriptions.push(cocosEffectContext);

	languages.registerDocumentSemanticTokensProvider({ language: 'cocos-effect' }, new CocosSemanticTokensProvider(outputChannel), legend);
	languages.registerDocumentSemanticTokensProvider({ language: 'cocos-program' }, new CocosSemanticTokensProvider(outputChannel), legend);

	const serverModule = context.asAbsolutePath(path.join('out', 'server.js'));

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
				const document = editor.document.fileName;
				if (document.endsWith('.effect') === false) {
					window.showErrorMessage('Not a valid effect file!');
					return;
				}
				const documentPath = path.dirname(document);
				let engineDirectory = enginePath ? enginePath : '';
				const engine = find_if_upwards(documentPath, is_engine_path);
				const project = find_if_upwards(documentPath, is_project_path);
				if (engine !== '') {
					engineDirectory = engine;
				}
				if (project !== '') {
					engineDirectory = find_if_upwards(get_project_engine_dir(project), is_engine_path);
				}
				const compiler_path = path.join(engineDirectory, compilerExecPath);
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
