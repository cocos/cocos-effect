import * as fs from 'fs';
import * as path from 'path';

export const chunkSubPath = '/editor/assets/chunks';
export const chunkCachePath = '/editor/assets/tools/parsed-effect-info.json';
export const compilerExecPath = '/native/external/win64/bin/effect-checker/effect-checker.exe';

/**
 * find files or directories upwards if the operation returns true
 * 
 * @param pth the path to start searching from
 * @param operation the operation to perform on each path
 * @returns the path where the operation returned true, or '' if not found
 */
export function find_if_upwards(pth: string, operation: (path: string) => boolean): string {
	let currentDir = pth;
	if (fs.statSync(pth).isFile()) {
		currentDir = path.dirname(pth);
	} else if (fs.statSync(pth).isDirectory()) {
		currentDir = pth;
	} else {
		return '';
	}

	let prevDir = '';
	while (currentDir !== prevDir) {
		if (operation(currentDir)) {
			return currentDir;
		}
		prevDir = currentDir;
		currentDir = path.dirname(currentDir);
	}
	return '';
}

/**
 * Check if the path is a cocos creator engine path
 * 
 * @param pth the path to check
 * @returns true if the path is a cocos creator engine path
 */
export function is_engine_path(pth: string): boolean {
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

/**
 * Check if the path is a cocos creator path
 */
export function is_cocos_creator_path(pth: string): boolean {
	if (pth === '' || !fs.existsSync(pth) || !fs.statSync(pth).isDirectory()) {
		return false;
	}
	const engine_path = path.join(pth, 'resources', 'resources', '3d', 'engine');
	const mac_engine_path = path.join(pth, 'Contents', 'Resources', 'resources', '3d', 'engine');
	const develop_engine_path = path.join(pth, 'resources', '3d', 'engine');
	return is_engine_path(develop_engine_path) || is_engine_path(engine_path) || is_engine_path(mac_engine_path);
}

/**
 * Check if the path is a cocos creator project path
 * 
 * @param pth the path to check
 * @returns 
 */
export function is_project_path(pth: string): boolean {
	const currentDir = pth;
	const ccDtsPath = path.join(currentDir, 'temp', 'declarations', 'cc.d.ts');
	if (fs.existsSync(ccDtsPath)) {
		return true;
	}
	return false;
}

/**
 * Get the engine path from the project path
 * 
 * @param projectRoot the path to the project root
 * @returns the path to the engine directory
 */
export function get_project_engine_dir(projectRoot: string): string {
	const ccDtsPath = path.join(projectRoot, 'temp', 'declarations', 'cc.d.ts');
	if (fs.existsSync(ccDtsPath)) {
		// read the cc.d.ts file
		const text = fs.readFileSync(ccDtsPath, 'utf8');
		// find the line that contains the engine path
		const referencePathRegExp = /\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>/;
		const match = referencePathRegExp.exec(text);
		if (match && match.length > 1) {
			return match[1];
		}
	}
	return '';
}

/**
 * Get the engine path from the creator path
 * 
 * @param creatorPath the path to the creator root
 * @returns the path to the engine directory
 */
export function get_creator_engine_path(creatorPath: string): string {
	const engine_path = path.join(creatorPath, 'resources', 'resources', '3d', 'engine');
	const mac_engine_path = path.join(creatorPath, 'Contents', 'Resources', 'resources', '3d', 'engine');
	const develop_engine_path = path.join(creatorPath, 'resources', '3d', 'engine');
	if (is_engine_path(develop_engine_path)) { // dev editor
		return develop_engine_path;
	} else if (is_engine_path(engine_path)) { // released editor on windows
		return engine_path;
	} else if (is_engine_path(mac_engine_path)) { // released editor on mac
		return mac_engine_path;
	}
	return '';
}