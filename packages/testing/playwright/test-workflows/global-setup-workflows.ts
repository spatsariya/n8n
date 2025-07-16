import { execFile, execSync } from 'child_process';
import { promises as fsPromises, existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

// Only run the file once, so we don't run it multiple times
const execFileAsync = promisify(execFile);

const N8N_CLI_PATH_ENV_VAR = process.env.N8N_CLI_PATH;
const N8N_CLI_POSSIBLE_PATHS = ['../../../cli/bin/n8n', '../../cli/bin/n8n'];
const CREDENTIALS_FILE_NAME = 'credentials.json';
const WORKFLOWS_DIR_NAME = 'workflows';
const ASSETS_SOURCE_PATH = path.join(__dirname, '../../../assets');
const PDF_SOURCE_DIR = path.join(__dirname, 'testData', 'pdfs');

const BASE_TMP_DIR = '/tmp';
const TMP_PDF_DEST_DIR = path.join(BASE_TMP_DIR, 'testData', 'pdfs');

/**
 * Finds the n8n CLI executable path.
 * It first checks an environment variable, then common relative paths,
 * and finally attempts to find it in the system's PATH.
 * @returns The resolved absolute path to the n8n CLI.
 * @throws {Error} If the n8n CLI cannot be located.
 */
function getN8nPath(): string {
	if (N8N_CLI_PATH_ENV_VAR) {
		console.log(`Using n8n CLI path from environment variable: ${N8N_CLI_PATH_ENV_VAR}`);
		return N8N_CLI_PATH_ENV_VAR;
	}

	for (const p of N8N_CLI_POSSIBLE_PATHS) {
		const resolvedPath = path.resolve(__dirname, p);
		if (existsSync(resolvedPath)) {
			console.log(`Found n8n CLI at relative path: ${resolvedPath}`);
			return resolvedPath;
		}
	}

	try {
		// Fallback to 'which n8n' for globally installed n8n
		const n8nPath = execSync('which n8n', { encoding: 'utf-8' }).trim();
		if (n8nPath) {
			console.log(`Found n8n CLI in system PATH: ${n8nPath}`);
			return n8nPath;
		}
	} catch (error) {
		// Ignore if 'which n8n' fails; it just means it's not in the PATH
		console.warn("Could not find 'n8n' in system PATH.");
	}

	throw new Error(
		'n8n CLI not found. Please set the N8N_CLI_PATH environment variable, ' +
			"ensure it's in your system's PATH, or check default installation paths.",
	);
}

/**
 * Executes an n8n CLI command, providing robust error handling and logging.
 * @param command The n8n CLI subcommand (e.g., 'import:credentials').
 * @param args Arguments specific to the subcommand.
 * @param options Options for `child_process.execFile`. `cwd` is typically required.
 * @returns A promise that resolves with the stdout of the command, or rejects on error.
 */
async function runN8nCliCommand(
	command: string,
	args: string[],
	options: { cwd: string; [key: string]: any },
): Promise<string> {
	const n8nExecutablePath = getN8nPath();
	console.log(`Executing n8n command: n8n ${command} ${args.join(' ')}`);
	try {
		const { stdout, stderr } = await execFileAsync(n8nExecutablePath, [command, ...args], options);

		if (stderr) {
			console.warn(`CLI Command "${command}" produced stderr:\n${stderr.trim()}`);
		}
		console.log(`✅ CLI command "${command}" executed successfully.`);
		return stdout.trim();
	} catch (error: any) {
		const errorOutput = error.stderr ?? error.stdout ?? error.message;
		console.error(`❌ Failed to execute n8n CLI command "${command}":\n${errorOutput.trim()}`);
		throw new Error(`n8n CLI command "${command}" failed: ${errorOutput.trim()}`);
	}
}

/**
 * Recursively copies files and directories from a source path to a destination path.
 * If the source is a directory, it creates the destination directory and copies its contents.
 * If the source is a file, it copies the file.
 * Handles cases where the source path does not exist gracefully.
 * @param sourcePath The path to the source file or directory.
 * @param destinationPath The path where the file(s) or directory should be copied.
 */
async function copyAsset(sourcePath: string, destinationPath: string): Promise<void> {
	try {
		const stats = await fsPromises.stat(sourcePath);

		if (stats.isDirectory()) {
			await fsPromises.mkdir(destinationPath, { recursive: true });
			const items = await fsPromises.readdir(sourcePath);
			await Promise.all(
				items.map((item) =>
					copyAsset(path.join(sourcePath, item), path.join(destinationPath, item)),
				),
			);
			console.log(`📁 Directory copied: ${sourcePath} to ${destinationPath}`);
		} else if (stats.isFile()) {
			await fsPromises.copyFile(sourcePath, destinationPath);
			console.log(`📄 File copied: ${sourcePath} to ${destinationPath}`);
		}
	} catch (error: any) {
		if (error.code === 'ENOENT') {
			console.warn(`⚠️ Warning: Source asset not found at ${sourcePath}. Skipping copy.`);
		} else {
			console.error(
				`❌ Error copying asset from ${sourcePath} to ${destinationPath}: ${error.message}`,
			);
			throw error;
		}
	}
}

/**
 * Sets up the n8n test environment by importing credentials and workflows,
 * and copying necessary test data/assets.
 * This function is designed to be used as a global setup hook in testing frameworks.
 */
export async function globalSetup(): Promise<void> {
	console.log('\n--- 🚀 Starting n8n workflow test environment setup ---\n');

	try {
		// 1. Import credentials
		console.log('📥 Importing test credentials...');
		await runN8nCliCommand('import:credentials', ['--input', CREDENTIALS_FILE_NAME], {
			cwd: __dirname,
		});

		// 2. Import workflows
		console.log('📥 Importing test workflows...');
		await runN8nCliCommand('import:workflow', ['--separate', '--input', WORKFLOWS_DIR_NAME], {
			cwd: __dirname,
		});

		// 3. Copy test data/assets
		console.log('📁 Copying test assets...');

		await fsPromises.mkdir(BASE_TMP_DIR, { recursive: true });

		await copyAsset(
			path.join(ASSETS_SOURCE_PATH, 'n8n-logo.png'),
			path.join(BASE_TMP_DIR, 'n8n-logo.png'),
		);
		await copyAsset(
			path.join(ASSETS_SOURCE_PATH, 'n8n-screenshot.png'),
			path.join(BASE_TMP_DIR, 'n8n-screenshot.png'),
		);

		await copyAsset(PDF_SOURCE_DIR, TMP_PDF_DEST_DIR);

		console.log('\n--- ✅ n8n workflow test environment setup complete! ---\n');
	} catch (error: any) {
		console.error('\n--- ❌ n8n workflow test environment setup failed! ---\n', error.message);
		process.exit(1);
	}
}
