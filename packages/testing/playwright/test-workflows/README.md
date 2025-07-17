# Workflow Testing Framework

## Introduction

This framework tests n8n's nodes and workflows to:

* ✅ **Ensure Correctness:** Verify that nodes operate correctly
* 🔄 **Maintain Compatibility:** Detect breaking changes in external APIs
* 🔒 **Guarantee Stability:** Prevent regressions in new releases

## Our Move to Playwright

This framework is an evolution of a previous system. We moved to **Playwright** as our test runner to leverage its powerful, industry-standard features, resulting in:

* **Simpler Commands:** A single command to run tests, with simple flags for control
* **Better Reporting:** Rich, interactive HTML reports with visual diffs for snapshot failures
* **Built-in Features:** Automatic retries, parallel execution, and CI integration out of the box
* **Less Maintenance:** No custom CLI commands needed for test execution

---

## 🚀 Quick Start

### Prerequisites

1. **Set encryption key:** The test credentials are encrypted. Add to `~/.n8n/config`:
   ```json
   {
     "N8N_ENCRYPTION_KEY": "YOUR_KEY_FROM_BITWARDEN"
   }
   ```
   Find the key in Bitwarden under "Testing Framework encryption key"

2. **Fresh database (optional):** For a clean start, remove `~/.n8n/database.sqlite` if it exists

The global setup automatically handles importing workflows, credentials, and copying test files.

### Basic Commands

```bash
# 1. Just run workflows (check they execute without errors)
pnpm --filter n8n-playwright test:workflows

# 2. Run and compare against snapshots
SNAPSHOTS=compare pnpm --filter n8n-playwright test:workflows

# 3. Update/create snapshots
SNAPSHOTS=update pnpm --filter n8n-playwright test:workflows

# 4. Run specific workflows (using grep)
pnpm --filter n8n-playwright test:workflows -g "email"
```

### View Test Results

After any test run, open the interactive HTML report:
```bash
npx playwright show-report
```

The report shows:
* ✅ Passed/❌ Failed tests with execution times
* 📸 Snapshot diffs with visual comparison
* ⚠️ Warnings and annotations
* 📊 Test trends over time (in CI)

---

## ⚙️ How It Works

### Test Modes

1. **Basic Run** (default): Executes workflows and checks for errors
2. **Snapshot Comparison**: Compares workflow output against saved snapshots
3. **Snapshot Update**: Creates or updates the expected output snapshots

### Snapshot Testing

When a workflow runs successfully, its output can be saved as a "snapshot" (JSON file). Future runs compare against this snapshot to detect changes.

* ✅ **Match** = Test passes
* ❌ **Differ** = Test fails (HTML report shows exact differences)

---

## 🎯 Advanced Usage

### Shallow Mode (Default for Snapshots)

When using snapshots, the default mode is "shallow" which simplifies complex data:
* Arrays become `["json array"]`
* Objects become `{ object: true }`

This helps avoid false positives from complex nested data structures.

```bash
# Update snapshots (shallow mode by default)
SNAPSHOTS=update pnpm --filter n8n-playwright test:workflows

# Compare snapshots (shallow mode by default)
SNAPSHOTS=compare pnpm --filter n8n-playwright test:workflows

# Use deep mode when you need exact data matching
SNAPSHOTS=update SNAPSHOT_MODE=deep pnpm --filter n8n-playwright test:workflows
SNAPSHOTS=compare SNAPSHOT_MODE=deep pnpm --filter n8n-playwright test:workflows
```

⚠️ **Important**: Snapshots created in one mode must be compared in the same mode!

### Handling Dynamic Data

For data that changes every run (timestamps, IDs), add rules to a node's **Notes** field in n8n:

```
CAP_RESULTS_LENGTH=1
IGNORED_PROPERTIES=createdAt,id,timestamp
KEEP_ONLY_PROPERTIES=status,type
```

* `CAP_RESULTS_LENGTH`: Limit output array to N items
* `IGNORED_PROPERTIES`: Remove these fields before comparison
* `KEEP_ONLY_PROPERTIES`: Keep only these fields (removes everything else)

### Skip List

To skip specific workflows, add their IDs to `test-workflows/skipList.json`:
```json
[
  { "workflowId": "123" },
  { "workflowId": "456" }
]
```

---

## 📋 Environment Variables Reference

| Variable | Values | Description |
|----------|--------|-------------|
| `SNAPSHOTS` | `compare`, `update` | Compare against or update snapshots (omit for basic run) |
| `SNAPSHOT_MODE` | `deep` | Use exact data matching (default is `shallow`) |

---

## 💡 Common Scenarios

### "I just want to check if workflows run"
```bash
pnpm --filter n8n-playwright test:workflows
```

### "I changed a workflow and need to update its expected output"
```bash
SNAPSHOTS=update pnpm --filter n8n-playwright test:workflows -g "workflow-name"
```

### "I want to test everything against saved snapshots"
```bash
SNAPSHOTS=compare pnpm --filter n8n-playwright test:workflows
```

### "My workflow has lots of dynamic data"
Use shallow mode or add node rules (see Advanced Usage above)

---

## 🔧 Creating and Exporting Tests

### Creating Tests

1. **One node per workflow:** Test a single node with multiple operations/resources
2. **Use test files:** Reference the files in `/tmp` (see Available Test Files)
3. **Limit results:** Set "Limit" to 1 for "Get All" operations when possible
4. **Handle throttling:** Add wait/sleep nodes for rate-limited APIs

### Exporting Workflows and Credentials

After creating/updating tests in n8n:

```bash
# Export a specific workflow
./packages/cli/bin/n8n export:workflow --separate --output=test-workflows/workflows --pretty --id=XXX

# Export all credentials (encrypted)
./packages/cli/bin/n8n export:credentials --output=test-workflows/credentials.json --all --pretty
```

⚠️ **Never use `--decrypted` when exporting credentials!**

### Dealing with Expired Credentials

When tests fail due to expired credentials:
1. Set up the environment locally (see Prerequisites)
2. Reconnect the failing service in n8n
3. Export the updated credentials
4. Submit a PR with the updated `credentials.json`