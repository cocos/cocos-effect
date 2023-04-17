import {
	workspace,
	Disposable,
	OutputChannel,
} from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

class CocosLanguageClient extends LanguageClient {
}

export class CocosEffectContext implements Disposable {
	subscriptions: Disposable[] = [];
	client!: CocosLanguageClient;

	async activate(serverModule: string, outputChannel: OutputChannel) {
		const serverOptions: ServerOptions = {
			run: {
				module: serverModule,
				transport: TransportKind.ipc
			},
			debug: {
				module: serverModule,
				transport: TransportKind.ipc,
			}
		};

		// Options to control the language client
		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ scheme: 'file', language: 'cocos-program' }],
			synchronize: {
				fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
			},
			outputChannel: outputChannel,
		};
		this.client = new CocosLanguageClient(
			'CocosEffect Language Server',
			serverOptions,
			clientOptions
		);
		this.client.start();
		console.log('Clang Language Server is now active!');
	}

	dispose() {
		this.subscriptions.forEach(sub => sub.dispose());
		if (this.client) {
			this.client.stop();
		}
		this.subscriptions.length = 0;
	}
}