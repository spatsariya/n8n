/* eslint-disable playwright/no-conditional-in-test */
import { test, expect, type TestInfo } from '@playwright/test';
import type { ExecSyncOptionsWithStringEncoding } from 'child_process';
import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';

import { globalWorkflowSetup } from './global-setup-workflows';

const SETUP_LOCK_FILE = path.join(__dirname, '.workflow-setup-complete');

// Ensure setup runs only once across all workers
test.beforeAll(async () => {
	// Check if setup has already been done
	if (fs.existsSync(SETUP_LOCK_FILE)) {
		const setupTime = fs.statSync(SETUP_LOCK_FILE).mtime;
		const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

		// If setup was done within the last hour, skip
		if (setupTime > hourAgo) {
			console.log('✅ Workflow setup already complete (cached)');
			return;
		}
	}

	// Acquire lock and run setup
	const lockFile = `${SETUP_LOCK_FILE}.lock`;
	const maxWaitTime = 60000; // 60 seconds
	const startTime = Date.now();

	// Wait for any other worker that might be setting up
	while (fs.existsSync(lockFile)) {
		if (Date.now() - startTime > maxWaitTime) {
			throw new Error('Timeout waiting for workflow setup lock');
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	// If setup is now complete, we're done
	if (fs.existsSync(SETUP_LOCK_FILE)) {
		console.log('✅ Workflow setup completed by another worker');
		return;
	}

	try {
		// Create lock file
		fs.writeFileSync(lockFile, process.pid.toString());

		// Run setup
		console.log('🚀 Running workflow setup...');
		await globalWorkflowSetup();

		// Mark setup as complete
		fs.writeFileSync(SETUP_LOCK_FILE, new Date().toISOString());
		console.log('✅ Workflow setup complete');
	} finally {
		// Remove lock file
		if (fs.existsSync(lockFile)) {
			fs.unlinkSync(lockFile);
		}
	}
});

const WORKFLOWS_SOURCE_DIR = path.join(__dirname, 'workflows');
const WORKFLOW_SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const WORKFLOW_SKIP_LIST_FILE = path.join(__dirname, 'skipList.json');

const N8N_CLI_TEST_PATH = '../../../cli/bin/n8n';

const MAX_EXEC_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB

const WARNING_PATTERNS = new Set([
	'429',
	'rate limit',
	'timeout',
	'timed out',
	'econnreset',
	'econnrefused',
	'insufficient balance',
	'refresh token',
	'503',
	'502',
	'504',
]);

const GLOBALLY_IGNORED_PROPERTIES = [
	'executionTime',
	'startTime',
	'startedAt',
	'stoppedAt',
	'containerId',
	'isAgentRunning',
	'nbLaunches',
	'lastEndedAt',
];

// --- Type Definitions ---

interface Workflow {
	id: string;
	name: string;
	nodes?: WorkflowNode[];
	[key: string]: any;
}

interface WorkflowNode {
	name: string;
	notes?: string;
	[key: string]: any;
}

interface RunDataItem {
	json?: Record<string, any>;
	[key: string]: any;
}

interface RunDataOutput {
	data?: {
		main?: RunDataItem[][];
		[key: string]: RunDataItem[][];
	};
	[key: string]: any;
}

interface WorkflowExecutionResult {
	data?: {
		resultData?: {
			runData?: Record<string, RunDataOutput[]>;
			error?: {
				message?: string;
				description?: string;
				[key: string]: any;
			} | null;
		};
	};
	[key: string]: any;
}

interface NodeRules {
	capResults?: number;
	ignoredProperties?: string[];
	keepOnlyProperties?: string[];
}

interface TestMode {
	shouldCompareSnapshots: boolean;
	shouldUpdateSnapshots: boolean;
	isShallow: boolean;
}

// --- Helper Functions ---

/**
 * Gets the test mode configuration from environment variables
 */
function getTestMode(): TestMode {
	const snapshotsMode = process.env.SNAPSHOTS?.toLowerCase();
	// Default to shallow mode unless explicitly set to deep
	const isShallow = process.env.SNAPSHOT_MODE?.toLowerCase() !== 'deep';

	return {
		shouldCompareSnapshots: snapshotsMode === 'compare',
		shouldUpdateSnapshots: snapshotsMode === 'update',
		isShallow,
	};
}

/**
 * Recursively traverses an object or array and removes any properties that
 * match the keys in the provided list.
 */
function removePropertiesRecursively(obj: any, propertiesToRemove: string[]): void {
	if (obj === null || typeof obj !== 'object') {
		return;
	}

	if (Array.isArray(obj)) {
		obj.forEach((item) => removePropertiesRecursively(item, propertiesToRemove));
		return;
	}

	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			if (propertiesToRemove.includes(key)) {
				delete obj[key];
			} else {
				removePropertiesRecursively(obj[key], propertiesToRemove);
			}
		}
	}
}

/**
 * Removes globally ignored dynamic properties from the result object to ensure
 * deterministic snapshot comparisons.
 */
function sanitizeResult(result: WorkflowExecutionResult): void {
	removePropertiesRecursively(result, GLOBALLY_IGNORED_PROPERTIES);
}

/**
 * Performs a deep, recursive comparison of two objects and returns a list of
 * dot-notation paths to any properties that differ.
 *
 * Note: This function always performs a deep comparison. "Shallow" testing is
 * achieved by simplifying the `actual` data with `processShallow` *before*
 * calling this function.
 */
function findDifferences(expected: any, actual: any, path = ''): string[] {
	const differences: string[] = [];

	if (expected === actual) return differences;

	if (
		typeof expected !== 'object' ||
		expected === null ||
		typeof actual !== 'object' ||
		actual === null ||
		Array.isArray(expected) !== Array.isArray(actual)
	) {
		if (path) differences.push(path);
		return differences;
	}

	if (Array.isArray(expected)) {
		if (expected.length !== actual.length && path) {
			differences.push(path);
		}
		const len = Math.min(expected.length, actual.length);
		for (let i = 0; i < len; i++) {
			differences.push(...findDifferences(expected[i], actual[i], `${path}[${i}]`));
		}
	} else {
		const expectedKeys = new Set(Object.keys(expected));
		const actualKeys = new Set(Object.keys(actual));
		const allKeys = new Set([...expectedKeys, ...actualKeys]);

		for (const key of allKeys) {
			const newPath = path ? `${path}.${key}` : key;
			if (!actualKeys.has(key) || !expectedKeys.has(key)) {
				differences.push(newPath);
			} else {
				differences.push(...findDifferences(expected[key], actual[key], newPath));
			}
		}
	}

	return [...new Set(differences)]; // Return unique paths
}

/**
 * Loads workflows from the specified directory and a skip list from a JSON file.
 */
function loadWorkflowsAndSkipList(): { workflows: Workflow[]; skipList: Set<string> } {
	const workflows: Workflow[] = fs
		.readdirSync(WORKFLOWS_SOURCE_DIR)
		.filter((file) => file.endsWith('.json'))
		.map((file) => {
			const content = fs.readFileSync(path.join(WORKFLOWS_SOURCE_DIR, file), 'utf-8');
			return JSON.parse(content) as Workflow;
		});

	const skipList: Set<string> = fs.existsSync(WORKFLOW_SKIP_LIST_FILE)
		? new Set(
				JSON.parse(fs.readFileSync(WORKFLOW_SKIP_LIST_FILE, 'utf-8')).map((s: any) =>
					String(s.workflowId),
				),
			)
		: new Set();

	return { workflows, skipList };
}

/**
 * Executes an n8n workflow via the CLI and processes its raw JSON output.
 */
function runWorkflowAndHandleOutput(
	workflowId: string,
	testInfo: TestInfo,
): WorkflowExecutionResult | undefined {
	const command = `${N8N_CLI_TEST_PATH} execute --id="${workflowId}" --rawOutput`;

	if (process.env.DEBUG) {
		console.log(`Executing: ${command}`);
	}

	const options: ExecSyncOptionsWithStringEncoding = {
		encoding: 'utf-8',
		maxBuffer: MAX_EXEC_BUFFER_SIZE,
		cwd: __dirname,
		env: {
			...process.env,
			...(process.env.N8N_ENCRYPTION_KEY && { N8N_ENCRYPTION_KEY: process.env.N8N_ENCRYPTION_KEY }),
			N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
			SKIP_STATISTICS_EVENTS: 'true',
		},
	};

	try {
		const output = execSync(command, options).toString();
		const jsonStartIndex = output.indexOf('{');
		if (jsonStartIndex === -1) {
			if (output.trim().length > 0) {
				throw new Error(`CLI output is not JSON and not empty: ${output}`);
			}
			return { data: { resultData: { runData: {}, error: null } } };
		}
		const potentialJson = output.substring(jsonStartIndex);
		try {
			return JSON.parse(potentialJson) as WorkflowExecutionResult;
		} catch (parseError: any) {
			throw new Error(
				`Failed to parse CLI output as JSON: ${parseError.message}\nRaw Output: ${output}`,
			);
		}
	} catch (error: any) {
		const fullStdout = error.stdout?.toString() ?? '';
		const fullStderr = error.stderr?.toString() ?? '';
		let workflowError: any = null;
		let actualErrorMessage = 'Unknown error during CLI execution.';

		const jsonStartIndexInErrorStdout = fullStdout.indexOf('{');
		if (jsonStartIndexInErrorStdout !== -1) {
			try {
				const potentialJson = fullStdout.substring(jsonStartIndexInErrorStdout);
				workflowError = JSON.parse(potentialJson)?.data?.resultData?.error;
			} catch (e) {
				// Not a JSON error, fall through
			}
		}

		if (workflowError) {
			actualErrorMessage = workflowError.message ?? workflowError.description ?? actualErrorMessage;
		} else {
			actualErrorMessage = fullStderr || error.message || actualErrorMessage;
		}

		const isWarning = [...WARNING_PATTERNS].some((pattern) =>
			actualErrorMessage.toLowerCase().includes(pattern),
		);

		if (isWarning) {
			testInfo.annotations.push({
				type: 'warning',
				description: `Execution warning: ${actualErrorMessage}`,
			});
			console.warn(`⚠️  Warning in workflow ${workflowId}: ${actualErrorMessage}`);
			return undefined;
		}

		// Log detailed info for critical errors and re-throw
		console.error(`❌ Workflow execution failed for ID ${workflowId}:`);
		console.error('--- CLI Stdout ---\n', fullStdout || '[No stdout]');
		console.error('--- CLI Stderr ---\n', fullStderr || '[No stderr]');
		if (workflowError) {
			console.error('--- Parsed Workflow Error ---\n', JSON.stringify(workflowError, null, 2));
		}
		throw new Error(`Workflow execution failed: ${actualErrorMessage}`);
	}
}

/**
 * Handles snapshot creation or comparison, adding annotations to the test report.
 */
function verifySnapshot(actual: object, workflowId: string, testInfo: TestInfo) {
	const { shouldCompareSnapshots, shouldUpdateSnapshots, isShallow } = getTestMode();

	// If snapshots are not enabled at all, skip
	if (!shouldCompareSnapshots && !shouldUpdateSnapshots) {
		console.log(`ℹ️  Skipping snapshot handling for ${workflowId} (snapshots not enabled)`);
		testInfo.annotations.push({ type: 'snapshot', description: 'Snapshots not enabled' });
		return;
	}

	const snapshotPath = path.join(WORKFLOW_SNAPSHOTS_DIR, `${workflowId}-snapshot.json`);

	if (shouldUpdateSnapshots) {
		const isUpdate = fs.existsSync(snapshotPath);
		console.log(`💾 ${isUpdate ? 'Updating' : 'Creating'} snapshot for workflow ${workflowId}...`);

		if (!fs.existsSync(WORKFLOW_SNAPSHOTS_DIR)) {
			fs.mkdirSync(WORKFLOW_SNAPSHOTS_DIR, { recursive: true });
		}

		// Store snapshot with metadata
		const snapshotData = {
			_meta: {
				shallow: isShallow,
				createdAt: new Date().toISOString(),
				workflowId: workflowId,
			},
			result: actual,
		};

		fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2), 'utf-8');

		testInfo.annotations.push({
			type: 'snapshot',
			description: `${isUpdate ? 'Updated' : 'Created'} (${isShallow ? 'shallow' : 'deep'} mode)`,
		});
		console.log(`   Snapshot saved to: ${snapshotPath} in ${isShallow ? 'shallow' : 'deep'} mode`);
		return;
	}

	// shouldCompareSnapshots is true here
	if (!fs.existsSync(snapshotPath)) {
		throw new Error(
			`📸 Snapshot not found for workflow ${workflowId}. Run with SNAPSHOTS=update to create it.`,
		);
	}

	const snapshotContent = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));

	// Handle both old format (direct result) and new format (with metadata)
	let expected: any;
	let snapshotIsShallow: boolean | undefined;

	if (snapshotContent._meta) {
		// New format with metadata
		expected = snapshotContent.result;
		snapshotIsShallow = snapshotContent._meta.shallow;

		// Check for mode mismatch
		if (snapshotIsShallow !== undefined && snapshotIsShallow !== isShallow) {
			const warningMessage = `⚠️  Mode mismatch for workflow ${workflowId}: Snapshot was created in ${snapshotIsShallow ? 'shallow' : 'deep'} mode, but test is running in ${isShallow ? 'shallow' : 'deep'} mode. Consider updating the snapshot with SNAPSHOTS=update`;

			console.warn(warningMessage);
			testInfo.annotations.push({
				type: 'warning',
				description: warningMessage,
			});
		}
	} else {
		// Old format - direct result
		expected = snapshotContent;
		console.log(
			`ℹ️  Legacy snapshot format detected for workflow ${workflowId}. Consider updating with SNAPSHOTS=update`,
		);
	}

	const differences = findDifferences(expected, actual);
	if (differences.length > 0) {
		testInfo.annotations.push({
			type: 'diff',
			description: `Snapshot differences found in fields:\n- ${differences.join('\n- ')}`,
		});
	}

	expect(actual).toEqual(expected);
}

/**
 * Simplifies nested objects and arrays in a workflow result to placeholders.
 * This is used when `SNAPSHOT_MODE` is not 'deep' (shallow is default).
 *
 * In shallow mode, this function:
 * 1. Applies node special cases (capResults, ignoredProperties, keepOnlyProperties)
 * 2. Converts remaining arrays to ['json array'] and objects to { object: true }
 *
 * This ensures that top-level attributes are kept with their correct types,
 * while reducing false positives from complex nested data.
 */
function processShallow(data: WorkflowExecutionResult, workflow: Workflow): void {
	const runData = data.data?.resultData?.runData;
	if (!runData) return;

	// Extract node special cases
	const specialCases: Record<string, NodeRules> = {};
	workflow.nodes?.forEach((node) => {
		if (!node.notes) return;
		const rules: NodeRules = {};
		node.notes.split('\n').forEach((line) => {
			const [key, value] = line.split('=').map((s) => s?.trim());
			if (!key || !value) return;
			switch (key) {
				case 'CAP_RESULTS_LENGTH':
					rules.capResults = parseInt(value, 10);
					if (isNaN(rules.capResults)) delete rules.capResults;
					break;
				case 'IGNORED_PROPERTIES':
					rules.ignoredProperties = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
					break;
				case 'KEEP_ONLY_PROPERTIES':
					rules.keepOnlyProperties = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
					break;
			}
		});
		if (Object.keys(rules).length > 0) specialCases[node.name] = rules;
	});

	for (const nodeName in runData) {
		if (!Object.prototype.hasOwnProperty.call(runData, nodeName)) continue;

		const nodeRules = specialCases[nodeName] || {};

		runData[nodeName].forEach((run) => {
			if (!run.data) return;

			// Process all properties under data, not just 'main'
			for (const outputType in run.data) {
				if (!Object.prototype.hasOwnProperty.call(run.data, outputType)) continue;
				const outputs = run.data[outputType];

				if (!Array.isArray(outputs)) continue;

				outputs.forEach((outputArray) => {
					if (!Array.isArray(outputArray)) return;

					// Apply capResults first
					if (nodeRules.capResults !== undefined && outputArray.length > nodeRules.capResults) {
						outputArray.splice(nodeRules.capResults);
					}

					outputArray.forEach((item) => {
						if (!item?.json || typeof item.json !== 'object') return;

						// Apply ignoredProperties
						if (nodeRules.ignoredProperties) {
							nodeRules.ignoredProperties.forEach((prop) => delete item.json?.[prop]);
						}

						// Apply keepOnlyProperties
						if (nodeRules.keepOnlyProperties) {
							const newJson: Record<string, any> = {};
							nodeRules.keepOnlyProperties.forEach((prop) => {
								if (Object.prototype.hasOwnProperty.call(item.json, prop))
									newJson[prop] = item.json?.[prop];
							});
							item.json = newJson;
						}

						// Now apply shallow processing to remaining properties
						for (const key in item.json) {
							if (!Object.prototype.hasOwnProperty.call(item.json, key)) continue;
							const value = item.json[key];
							if (Array.isArray(value)) item.json[key] = ['json array'];
							else if (value && typeof value === 'object') item.json[key] = { object: true };
						}
					});
				});
			}
		});
	}
}

/**
 * Applies special case rules defined in a workflow node's "Notes" field.
 * This allows for per-node modifications of the output data to handle
 * dynamic values like timestamps or random IDs.
 *
 * @example
 * // In the n8n UI, a node's Notes field might contain:
 * IGNORED_PROPERTIES=id,createdAt,updatedAt
 * CAP_RESULTS_LENGTH=1
 */
function applyNodeSpecialCases(data: WorkflowExecutionResult, workflow: Workflow): void {
	const specialCases: Record<string, NodeRules> = {};

	workflow.nodes?.forEach((node) => {
		if (!node.notes) return;
		const rules: NodeRules = {};
		node.notes.split('\n').forEach((line) => {
			const [key, value] = line.split('=').map((s) => s?.trim());
			if (!key || !value) return;
			switch (key) {
				case 'CAP_RESULTS_LENGTH':
					rules.capResults = parseInt(value, 10);
					if (isNaN(rules.capResults)) delete rules.capResults;
					break;
				case 'IGNORED_PROPERTIES':
					rules.ignoredProperties = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
					break;
				case 'KEEP_ONLY_PROPERTIES':
					rules.keepOnlyProperties = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
					break;
			}
		});
		if (Object.keys(rules).length > 0) specialCases[node.name] = rules;
	});

	const runData = data.data?.resultData?.runData;
	if (!runData || Object.keys(specialCases).length === 0) return;

	for (const nodeName in runData) {
		if (!Object.prototype.hasOwnProperty.call(runData, nodeName) || !specialCases[nodeName])
			continue;
		const rules = specialCases[nodeName];
		runData[nodeName].forEach((run) => {
			// Handle all output types, not just main
			if (!run.data) return;

			for (const outputType in run.data) {
				if (!Object.prototype.hasOwnProperty.call(run.data, outputType)) continue;
				const outputs = run.data[outputType];

				if (!Array.isArray(outputs)) continue;

				outputs.forEach((outputArray) => {
					if (!Array.isArray(outputArray)) return;

					if (rules.capResults !== undefined && outputArray.length > rules.capResults) {
						outputArray.splice(rules.capResults);
					}
					outputArray.forEach((item) => {
						if (!item?.json || typeof item.json !== 'object') return;
						if (rules.ignoredProperties) {
							rules.ignoredProperties.forEach((prop) => delete item.json?.[prop]);
						}
						if (rules.keepOnlyProperties) {
							const newJson: Record<string, any> = {};
							rules.keepOnlyProperties.forEach((prop) => {
								if (Object.prototype.hasOwnProperty.call(item.json, prop))
									newJson[prop] = item.json?.[prop];
							});
							item.json = newJson;
						}
					});
				});
			}
		});
	}
}

// --- Main Test Suite ---

test.describe('Workflow Execution Tests', () => {
	const { workflows, skipList } = loadWorkflowsAndSkipList();

	workflows.forEach((workflow) => {
		const workflowId = String(workflow.id);

		test(`Execute: ${workflow.name} (ID: ${workflowId})`, ({}, testInfo) => {
			test.skip(skipList.has(workflowId), 'Workflow is in skip list');

			console.log(`\n--- Running workflow: ${workflow.name} (ID: ${workflowId}) ---`);

			const result = runWorkflowAndHandleOutput(workflowId, testInfo);

			if (!result) {
				console.log(`ℹ️  Workflow ${workflowId} completed with warnings. Skipping snapshot.`);
				return;
			}

			sanitizeResult(result);

			const { isShallow } = getTestMode();
			if (isShallow) {
				console.log(`ℹ️  Applying shallow processing for workflow ${workflowId}.`);
				processShallow(result, workflow);
				testInfo.annotations.push({ type: 'processing', description: 'Shallow mode' });
			} else {
				// Only apply node special cases in deep mode
				// In shallow mode, they're applied within processShallow
				applyNodeSpecialCases(result, workflow);
			}

			verifySnapshot(result, workflowId, testInfo);

			// Update success message based on mode
			const { shouldCompareSnapshots, shouldUpdateSnapshots } = getTestMode();
			if (shouldCompareSnapshots) {
				console.log(`✅ Snapshot for workflow ${workflowId} matches.`);
			} else if (!shouldUpdateSnapshots) {
				console.log(`✅ Workflow ${workflowId} executed successfully.`);
			}
		});
	});
});
