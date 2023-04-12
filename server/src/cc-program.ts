
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult
} from 'vscode-languageserver/node';

import {
	ProgramRelations,
	// EffectPrograms,
} from './server';

const programRE = /CCProgram\s*([\w-]+)\s*%{([^]*?)(?:}%|%})/;

// export function extractPrograms(text : string) : EffectPrograms {
// 	return null!;
// }

const completion_cache = new Map<string, CompletionItem[]>();

export function program_completion_provider(text : string) : CompletionItem[] {
	return [];
}