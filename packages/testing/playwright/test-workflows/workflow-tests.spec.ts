/* eslint-disable playwright/no-conditional-in-test */
import { test } from '@playwright/test';
import type { ExecSyncOptionsWithStringEncoding } from 'child_process';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { diff } from 'json-diff';
import path from 'path';

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

// --- Type Definitions (for better type safety and readability) ---

interface Workflow {
	id: string;
	name: string;
	nodes?: WorkflowNode[];
	[key: string]: any; // Allow other properties
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
		main?: RunDataItem[][]; // Array of arrays, where inner array is items for that node run
	};
	[key: string]: any;
}

interface WorkflowExecutionResult {
	data?: {
		resultData?: {
			runData?: Record<string, RunDataOutput[]>; // NodeName -> Array of run outputs
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

// --- Helper Functions ---

/**
 * Loads workflows from the specified directory and a skip list from a JSON file.
 * @returns An object containing an array of parsed workflow objects and an array of skipped workflow IDs.
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
		: new Set(); // Use a Set for skipList for O(1) lookups

	return { workflows, skipList };
}

/**
 * Executes an n8n workflow via the CLI and processes its raw JSON output.
 * Handles CLI execution errors and extracts n8n specific error details.
 *
 * @param workflowId The ID of the workflow to execute.
 * @param testInfo Playwright's TestInfo object for annotations.
 * @returns The parsed JSON output from the workflow, or `undefined` if a warning occurred.
 * @throws {Error} If the workflow execution fails critically.
 */
function runWorkflowAndHandleOutput(
	workflowId: string,
	testInfo: any,
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
		},
	};

	try {
		const output = execSync(command, options).toString();

		const jsonStartIndex = output.indexOf('{');
		if (jsonStartIndex === -1) {
			// If no '{' is found, it's either truly empty or not JSON.
			// For --rawOutput, we generally expect JSON, even for empty results.
			if (output.trim().length > 0) {
				throw new Error(`CLI output is not JSON and not empty: ${output}`);
			}
			// If output is empty/whitespace, return a default empty structure for consistency.
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
		// This block catches errors from execSync (non-zero exit code).
		const fullStdout = error.stdout?.toString() ?? '';
		const fullStderr = error.stderr?.toString() ?? '';

		let workflowError: any = null;
		let actualErrorMessage = 'Unknown error during CLI execution.';

		// Prioritize extracting structured error from stdout if present (n8n CLI often puts errors here)
		const jsonStartIndexInErrorStdout = fullStdout.indexOf('{');
		if (jsonStartIndexInErrorStdout !== -1) {
			try {
				const potentialJson = fullStdout.substring(jsonStartIndexInErrorStdout);
				const parsedErrorOutput = JSON.parse(potentialJson);
				workflowError = parsedErrorOutput?.data?.resultData?.error;
			} catch (parseError) {
				// Not a JSON error, fall through to text parsing
			}
		}

		if (workflowError) {
			actualErrorMessage = workflowError.message ?? workflowError.description ?? actualErrorMessage;
		} else {
			// If no structured error, use stderr or the primary error message
			actualErrorMessage = fullStderr ?? error.message ?? actualErrorMessage;
		}

		const isWarning = WARNING_PATTERNS.has(actualErrorMessage.toLowerCase());

		if (isWarning) {
			testInfo.annotations.push({
				type: 'warning',
				description: `Execution warning: ${actualErrorMessage}`,
			});
			console.warn(`⚠️  Warning in workflow ${workflowId}: ${actualErrorMessage}`);
			return undefined; // Indicate a warning, not a failure
		}

		// It's a critical error. Log detailed info and re-throw.
		console.error(`❌ Workflow execution failed for ID ${workflowId}:`);
		console.error('--- CLI Stdout (from failed command) ---');
		console.error(fullStdout ?? '[No stdout]');
		console.error('--- CLI Stderr (from failed command) ---');
		console.error(fullStderr ?? '[No stderr]');
		if (workflowError) {
			console.error('--- Parsed Workflow Error Details ---');
			console.error(JSON.stringify(workflowError, null, 2));
		}

		throw new Error(`Workflow execution failed: ${actualErrorMessage}`);
	}
}

/**
 * Compares the workflow execution result with a stored snapshot.
 * Reports differences and throws an error for breaking changes.
 *
 * @param result The actual workflow execution result.
 * @param workflowId The ID of the executed workflow.
 * @param testInfo Playwright's TestInfo object for annotations.
 */
function compareWithSnapshot(result: WorkflowExecutionResult, workflowId: string, testInfo: any) {
	// Allow disabling snapshot comparison via environment variable
	if (process.env.WORKFLOW_TEST_COMPARE_SNAPSHOTS === 'false') {
		console.log(
			`ℹ️ Skipping snapshot comparison for ${workflowId} (WORKFLOW_TEST_COMPARE_SNAPSHOTS=false)`,
		);
		return;
	}

	const snapshotPath = path.join(WORKFLOW_SNAPSHOTS_DIR, `${workflowId}-snapshot.json`);

	if (!fs.existsSync(snapshotPath)) {
		testInfo.annotations.push({
			type: 'no-snapshot',
			description:
				'No snapshot file found for comparison. Consider running with WORKFLOW_TEST_SAVE_SNAPSHOTS=true',
		});
		console.warn(`⚠️  No snapshot found for workflow ${workflowId}. Skipping comparison.`);
		return;
	}

	const expected = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as WorkflowExecutionResult;
	// Use `diff.changes(a, b)` for a more concise diff object when just checking existence
	const changes = diff(expected, result, { keysOnly: true });

	if (changes) {
		const changesStr = JSON.stringify(changes, null, 2);
		const hasDeleted = changesStr.includes('__deleted');

		testInfo.annotations.push({ type: 'snapshot-diff', description: changesStr });

		if (hasDeleted) {
			throw new Error(
				`Breaking changes (deleted fields) detected in workflow ${workflowId} snapshot:\n${changesStr}`,
			);
		} else {
			console.warn(
				`⚠️  Non-breaking changes (new/modified fields) detected in workflow ${workflowId} snapshot:\n${changesStr}`,
			);
		}
	} else {
		console.log(`✅ Snapshot for workflow ${workflowId} matches.`);
	}
}

/**
 * Saves the workflow result as a snapshot file.
 * This operation is typically controlled by an environment variable.
 *
 * @param result The workflow execution result to save.
 * @param workflowId The ID of the workflow.
 * @param testInfo Playwright's TestInfo object for annotations.
 */
function saveSnapshot(result: WorkflowExecutionResult, workflowId: string, testInfo: any) {
	// Allow disabling snapshot saving via environment variable
	if (process.env.WORKFLOW_TEST_SAVE_SNAPSHOTS !== 'true') {
		console.log(
			`ℹ️ Skipping snapshot saving for ${workflowId} (WORKFLOW_TEST_SAVE_SNAPSHOTS is not 'true')`,
		);
		return;
	}

	if (!fs.existsSync(WORKFLOW_SNAPSHOTS_DIR)) {
		fs.mkdirSync(WORKFLOW_SNAPSHOTS_DIR, { recursive: true });
	}

	const snapshotPath = path.join(WORKFLOW_SNAPSHOTS_DIR, `${workflowId}-snapshot.json`);
	fs.writeFileSync(snapshotPath, JSON.stringify(result, null, 2), 'utf-8');

	testInfo.annotations.push({
		type: 'snapshot-saved',
		description: `Snapshot saved for workflow ${workflowId} at ${snapshotPath}`,
	});
	console.log(`💾 Snapshot saved for workflow ${workflowId}.`);
}

/**
 * Applies shallow processing to the workflow result, replacing complex structures
 * with simple placeholders for consistent snapshots.
 * @param data The workflow execution result object.
 */
function processShallow(data: WorkflowExecutionResult): void {
	const runData = data.data?.resultData?.runData;
	if (!runData) return;

	for (const nodeName in runData) {
		// Ensure we only iterate over own properties
		if (!Object.prototype.hasOwnProperty.call(runData, nodeName)) continue;

		const nodeRuns = runData[nodeName];
		if (!Array.isArray(nodeRuns)) continue;

		for (const run of nodeRuns) {
			const outputs = run.data?.main;
			if (!Array.isArray(outputs)) continue;

			for (const outputArray of outputs) {
				if (!Array.isArray(outputArray)) continue;

				for (const item of outputArray) {
					if (!item?.json || typeof item.json !== 'object') continue;

					for (const key in item.json) {
						if (!Object.prototype.hasOwnProperty.call(item.json, key)) continue;

						const value = item.json[key];
						if (Array.isArray(value)) {
							item.json[key] = ['json array']; // Replace array with a placeholder
						} else if (value && typeof value === 'object') {
							item.json[key] = { object: true }; // Replace object with a placeholder
						}
					}
				}
			}
		}
	}
}

/**
 * Applies special case rules defined in workflow node notes to modify the result data.
 * Rules include capping results, ignoring properties, or keeping only specific properties.
 *
 * @param data The workflow execution result object.
 * @param workflow The workflow definition object containing node notes.
 */
function applyNodeSpecialCases(data: WorkflowExecutionResult, workflow: Workflow): void {
	const specialCases: Record<string, NodeRules> = {};

	// 1. Extract special cases from node notes
	workflow.nodes?.forEach((node) => {
		if (!node.notes) return;

		const rules: NodeRules = {};
		node.notes.split('\n').forEach((line) => {
			const [key, value] = line.split('=').map((s) => s?.trim());
			if (!key || !value) return;

			switch (key) {
				case 'CAP_RESULTS_LENGTH':
					rules.capResults = parseInt(value, 10);
					if (isNaN(rules.capResults)) delete rules.capResults; // Ensure it's a valid number
					break;
				case 'IGNORED_PROPERTIES':
					rules.ignoredProperties = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean); // Filter out empty strings
					break;
				case 'KEEP_ONLY_PROPERTIES':
					rules.keepOnlyProperties = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
					break;
			}
		});

		if (Object.keys(rules).length > 0) {
			specialCases[node.name] = rules;
		}
	});

	// 2. Apply the rules to the run data
	const runData = data.data?.resultData?.runData;
	if (!runData || Object.keys(specialCases).length === 0) return;

	for (const nodeName in runData) {
		if (!Object.prototype.hasOwnProperty.call(runData, nodeName)) continue;

		const rules = specialCases[nodeName];
		if (!rules) continue;

		const nodeRuns = runData[nodeName];
		if (!Array.isArray(nodeRuns)) continue;

		for (const run of nodeRuns) {
			const outputs = run.data?.main;
			if (!Array.isArray(outputs)) continue;

			for (const outputArray of outputs) {
				if (!Array.isArray(outputArray)) continue;

				// Apply result cap (before property manipulation to avoid issues)
				if (rules.capResults !== undefined && outputArray.length > rules.capResults) {
					outputArray.splice(rules.capResults);
				}

				for (const item of outputArray) {
					if (!item?.json || typeof item.json !== 'object') continue;

					// Remove ignored properties
					if (rules.ignoredProperties?.length) {
						for (const prop of rules.ignoredProperties) {
							delete item.json[prop];
						}
					}

					// Keep only specified properties (applied after ignored to ensure precedence)
					if (rules.keepOnlyProperties?.length) {
						const newJson: Record<string, any> = {};
						for (const prop of rules.keepOnlyProperties) {
							if (Object.prototype.hasOwnProperty.call(item.json, prop)) {
								newJson[prop] = item.json[prop];
							}
						}
						item.json = newJson;
					}
				}
			}
		}
	}
}

// --- Main Test Suite ---

test.describe('Workflow Execution Tests', () => {
	const { workflows, skipList } = loadWorkflowsAndSkipList();

	// Dynamically create a test for each workflow found
	workflows.forEach((workflow) => {
		// Convert workflow ID to string early for consistent comparison
		const workflowId = String(workflow.id);

		test(`Execute: ${workflow.name} (ID: ${workflowId})`, ({}, testInfo) => {
			// Use test.skip for conditional skipping
			// eslint-disable-next-line playwright/no-skipped-test
			test.skip(skipList.has(workflowId), 'Workflow is in skip list');

			console.log(`\n--- Running workflow: ${workflow.name} (ID: ${workflowId}) ---\n`);

			// Execute the workflow and get the result
			const result = runWorkflowAndHandleOutput(workflowId, testInfo);

			// If `runWorkflowAndHandleOutput` returns undefined, it means a warning was
			// logged, and the test should not proceed to snapshot comparison/saving.
			if (!result) {
				console.log(
					`ℹ️ Workflow ${workflowId} completed with warnings. Skipping snapshot operations.`,
				);
				return;
			}

			// Apply data transformation rules before snapshot operations
			applyNodeSpecialCases(result, workflow);

			// Apply shallow processing if enabled via environment variable
			if (process.env.WORKFLOW_TEST_SHALLOW === 'true') {
				console.log(`ℹ️ Applying shallow processing for workflow ${workflowId}.`);
				processShallow(result);
			}

			// Compare and save snapshots
			compareWithSnapshot(result, workflowId, testInfo);
			saveSnapshot(result, workflowId, testInfo);

			console.log(`\n--- Workflow ${workflowId} test completed. ---\n`);
		});
	});
});
