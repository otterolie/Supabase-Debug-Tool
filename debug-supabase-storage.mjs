import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import https from "https";
import http from "http";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV_SUPABASE_URL = "NEXT_PUBLIC_SUPABASE_URL";
const ENV_SERVICE_KEY = "SUPABASE_SERVICE_ROLE_KEY";
const ENV_ANON_KEY = "NEXT_PUBLIC_SUPABASE_ANON_KEY";

const TEMP_DIR_PATH = path.join(__dirname, "supabase-debug-temp");
const TEST_TEXT_FILENAME = "debug-text.txt";
const TEST_IMAGE_FILENAME = "debug-image.png";
const DEFAULT_UPLOAD_PATH_PREFIX = "supabase-debug-tool";

const MIME_TYPES_MAP = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  default: "application/octet-stream",
};

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

dotenv.config();
let supabase;

const log = (color, prefix, message) =>
  console.log(`${color}${prefix} ${message}${COLORS.reset}`);
const logSuccess = (message) => log(COLORS.green, "✅", message);
const logError = (message) => log(COLORS.red, "❌ ERROR:", message);
const logWarn = (message) => log(COLORS.yellow, "⚠️ WARN:", message);
const logInfo = (message) => log(COLORS.cyan, "ℹ️ INFO:", message);
const logTip = (message) => log(COLORS.magenta, "💡 TIP:", message);

function ask(question) {
  return new Promise((resolve) =>
    rl.question(`${COLORS.bright}${question}${COLORS.reset} `, resolve)
  );
}

async function pressEnterToContinue() {
  console.log(`\n${COLORS.dim}Press Enter to return to menu...${COLORS.reset}`);
  await ask("");
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

function getErrorHint(error) {
  const msg = error.message?.toLowerCase() || "";
  if (
    msg.includes("unauthorized") ||
    msg.includes("access denied") ||
    msg.includes("jwt") ||
    msg.includes("token")
  ) {
    return `Auth issue. Verify API key, RLS policies, or use Service Role Key. Key might be expired or invalid.`;
  }
  if (msg.includes("not found") || msg.includes("does not exist")) {
    return `Resource (bucket, file) not found. Check names and paths.`;
  }
  if (msg.includes("timeout")) {
    return `Network timeout. Check connectivity, Supabase status, or firewall.`;
  }
  if (msg.includes("limit")) {
    return `Rate limit or resource limit exceeded. Check Supabase plan.`;
  }
  if (msg.includes("already exists")) {
    return `File already exists. Use 'upsert: true' or choose a different path if not intended.`;
  }
  return `Consult Supabase docs for: "${
    error.message || "Unknown Supabase error"
  }"`;
}

async function checkUrl(url) {
  return new Promise((resolve) => {
    const protocol = url.startsWith("https:") ? https : http;
    const req = protocol.get(url, { timeout: 5000 }, (res) => {
      resolve({
        accessible: res.statusCode >= 200 && res.statusCode < 400,
        statusCode: res.statusCode,
      });
      res.resume();
    });
    req.on("error", () =>
      resolve({ accessible: false, statusCode: 0, error: "Network error" })
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ accessible: false, statusCode: 0, error: "Timeout" });
    });
  });
}

async function validateEnvAndInitClient() {
  logInfo("Validating environment & initializing Supabase client...");
  const supabaseUrl = process.env[ENV_SUPABASE_URL];
  const serviceKey = process.env[ENV_SERVICE_KEY];
  const anonKey = process.env[ENV_ANON_KEY];
  const supabaseKey = serviceKey || anonKey;

  let valid = true;
  if (!supabaseUrl) {
    logError(`${ENV_SUPABASE_URL} is not set.`);
    valid = false;
  } else {
    try {
      new URL(supabaseUrl);
      logSuccess(`${ENV_SUPABASE_URL}: ${supabaseUrl}`);
    } catch {
      logError(`Invalid ${ENV_SUPABASE_URL}: ${supabaseUrl}`);
      valid = false;
    }
  }

  if (!supabaseKey) {
    logError(
      `No Supabase key found. Set ${ENV_SERVICE_KEY} (recommended) or ${ENV_ANON_KEY}.`
    );
    valid = false;
  } else {
    logSuccess(
      `Supabase Key: ${serviceKey ? "Service Role (SET)" : "Anon (SET)"}`
    );
    if (!serviceKey)
      logWarn(
        `Using Anon Key. For full debug capabilities, ${ENV_SERVICE_KEY} is STRONGLY recommended.`
      );
  }

  if (!valid) {
    logError("Critical environment variables missing or invalid. Exiting.");
    return false;
  }

  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    logSuccess("Supabase client initialized.");

    logInfo("Pinging Supabase URL...");
    const urlCheck = await checkUrl(supabaseUrl);
    if (urlCheck.accessible)
      logSuccess(`Supabase URL accessible (Status: ${urlCheck.statusCode}).`);
    else
      logWarn(
        `Supabase URL ping failed (Status: ${urlCheck.statusCode}, Error: ${
          urlCheck.error || "N/A"
        }). May be okay for some setups.`
      );
  } catch (error) {
    logError(`Supabase client initialization failed: ${error.message}`);
    return false;
  }
  return true;
}

async function coreUploadProcessor(
  bucketName,
  targetPath,
  fileSource,
  contentType,
  fileSize
) {
  logInfo(
    `Attempting upload: ${bucketName}/${targetPath} (${formatBytes(
      fileSize
    )}) Type: ${contentType}`
  );
  const startTime = Date.now();
  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(
        fileSource.path
          ? fs.createReadStream(fileSource.path)
          : fileSource.buffer,
        targetPath,
        {
          contentType,
          cacheControl: "3600",
          upsert: true,
        }
      );

    if (error) {
      logError(`Upload FAILED: ${error.message}`);
      logTip(getErrorHint(error));
      return null;
    }

    const duration = Date.now() - startTime;
    logSuccess(`Upload SUCCEEDED in ${duration}ms. Path: ${data.path}`);

    const { data: urlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(targetPath);
    if (urlData?.publicUrl) {
      logInfo(`Public URL: ${urlData.publicUrl}`);
      logInfo("Checking public URL accessibility...");
      const publicUrlCheck = await checkUrl(urlData.publicUrl);
      if (publicUrlCheck.accessible)
        logSuccess(
          `Public URL accessible (Status: ${publicUrlCheck.statusCode}).`
        );
      else
        logWarn(
          `Public URL check returned Status ${publicUrlCheck.statusCode}. May indicate RLS, CORS, or private bucket issue.`
        );
    } else {
      logWarn(
        "Could not retrieve public URL. Bucket might be private or an issue occurred."
      );
    }
    return data.path;
  } catch (e) {
    logError(`Critical upload exception: ${e.message}`);
    logTip(getErrorHint(e));
    return null;
  }
}

async function prepareTestFile(type) {
  if (!fs.existsSync(TEMP_DIR_PATH))
    fs.mkdirSync(TEMP_DIR_PATH, { recursive: true });

  if (type === "text") {
    const filePath = path.join(TEMP_DIR_PATH, TEST_TEXT_FILENAME);
    const content = `Supabase Storage Debug Tool: Test file generated at ${new Date().toISOString()}`;
    fs.writeFileSync(filePath, content);
    return {
      filePath,
      contentType: "text/plain",
      fileSize: Buffer.byteLength(content),
    };
  } else if (type === "image") {
    const filePath = path.join(TEMP_DIR_PATH, TEST_IMAGE_FILENAME);
    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const buffer = Buffer.from(base64Image, "base64");
    fs.writeFileSync(filePath, buffer);
    return { filePath, contentType: "image/png", fileSize: buffer.length };
  }
  return null;
}

async function handleGeneratedFileUpload(fileType) {
  console.clear();
  log(
    COLORS.blue,
    "===",
    `GENERATED ${fileType.toUpperCase()} FILE UPLOAD ===\n`
  );

  const bucketName = await ask("Enter bucket name:");
  if (!bucketName) {
    logError("Bucket name required.");
    return;
  }

  const testFile = await prepareTestFile(fileType);
  if (!testFile) {
    logError(`Failed to prepare test ${fileType} file.`);
    return;
  }

  const defaultFileName = path.basename(testFile.filePath);
  const storagePathInput = await ask(
    `Enter storage path (default: ${DEFAULT_UPLOAD_PATH_PREFIX}/${fileType}/${defaultFileName}):`
  );
  const storagePath =
    storagePathInput ||
    `${DEFAULT_UPLOAD_PATH_PREFIX}/${fileType}/${defaultFileName}`;

  await coreUploadProcessor(
    bucketName,
    storagePath,
    { path: testFile.filePath },
    testFile.contentType,
    testFile.fileSize
  );

  try {
    fs.unlinkSync(testFile.filePath);
    logInfo(`Cleaned up local test file: ${testFile.filePath}`);
  } catch (e) {
    logWarn(`Failed to cleanup local test file: ${e.message}`);
  }
}

async function handleCustomFileUpload() {
  console.clear();
  log(COLORS.blue, "===", `CUSTOM FILE UPLOAD ===\n`);

  const filePath = await ask("Enter FULL local file path:");
  if (!filePath || !fs.existsSync(filePath)) {
    logError(`File not found or path invalid: ${filePath}`);
    return;
  }

  const bucketName = await ask("Enter bucket name:");
  if (!bucketName) {
    logError("Bucket name required.");
    return;
  }

  const fileStats = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const guessedContentType = MIME_TYPES_MAP[ext] || MIME_TYPES_MAP.default;

  let contentType = await ask(
    `Enter content type (guessed: ${guessedContentType}):`
  );
  contentType = contentType || guessedContentType;

  const defaultFileName = path.basename(filePath);
  const storagePathInput = await ask(
    `Enter storage path (default: ${DEFAULT_UPLOAD_PATH_PREFIX}/custom/${defaultFileName}):`
  );
  const storagePath =
    storagePathInput ||
    `${DEFAULT_UPLOAD_PATH_PREFIX}/custom/${defaultFileName}`;

  await coreUploadProcessor(
    bucketName,
    storagePath,
    { path: filePath },
    contentType,
    fileStats.size
  );
}

async function checkConnectivity() {
  console.clear();
  log(COLORS.blue, "===", `CONNECTION & CONFIGURATION TEST ===\n`);
  logInfo("1. Basic Supabase Client & Auth Status:");
  if (supabase) logSuccess("Supabase client instance exists.");
  else {
    logError("Supabase client instance MISSING.");
    return;
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser().catch((e) => ({ data: {}, error: e }));
  if (userError && userError.message !== "Auth session missing!")
    logWarn(`Auth check warning: ${userError.message}`);
  else if (user) logSuccess(`Authenticated as user: ${user.id} (${user.role})`);
  else
    logInfo(
      "No active user session (normal for service key or unauthenticated anon key)."
    );

  logInfo("\n2. Storage API Test (Listing Buckets):");
  const { data: buckets, error: bucketsError } =
    await supabase.storage.listBuckets();
  if (bucketsError) {
    logError(`Storage API test FAILED: ${bucketsError.message}`);
    logTip(getErrorHint(bucketsError));
  } else {
    logSuccess(`Storage API accessible. Found ${buckets.length} buckets.`);
  }

  logInfo("\n3. CORS Check (Public Storage Endpoint):");
  const supabaseUrl = process.env[ENV_SUPABASE_URL];
  if (supabaseUrl) {
    const storagePublicUrl = `${supabaseUrl}/storage/v1/object/public/`;
    const corsCheck = await checkUrl(storagePublicUrl);
    if (corsCheck.accessible || corsCheck.statusCode === 400) {
      // 400 can be OK (e.g. listing not allowed on base public path)
      logSuccess(
        `Storage public endpoint seems accessible (Status: ${corsCheck.statusCode}).`
      );
    } else {
      logWarn(
        `Storage public endpoint check (Status: ${
          corsCheck.statusCode
        }, Error: ${corsCheck.error || "N/A"}). Possible CORS issue.`
      );
      logTip(
        "Verify CORS settings in Supabase Dashboard: Project Settings > API > Storage."
      );
    }
  } else {
    logWarn("Supabase URL not set, cannot perform CORS check.");
  }
}

async function showBuckets() {
  console.clear();
  log(COLORS.blue, "===", `STORAGE BUCKETS LIST ===\n`);
  try {
    const { data, error } = await supabase.storage.listBuckets();
    if (error) {
      logError(`Failed to list buckets: ${error.message}`);
      logTip(getErrorHint(error));
      return;
    }
    if (!data.length) {
      logWarn("No buckets found. Create buckets in your Supabase dashboard.");
      return;
    }
    logSuccess(`Found ${data.length} buckets:\n`);
    data.forEach((b) => {
      console.log(`${COLORS.bright}- Name: ${b.name}${COLORS.reset}`);
      console.log(`  ID: ${b.id}`);
      console.log(
        `  Public: ${
          b.public
            ? `${COLORS.green}Yes${COLORS.reset}`
            : `${COLORS.yellow}No${COLORS.reset}`
        }`
      );
      console.log(`  Created: ${new Date(b.created_at).toLocaleString()}`);
      console.log(
        `  File Size Limit: ${
          b.file_size_limit ? formatBytes(b.file_size_limit) : "N/A"
        }`
      );
      console.log(
        `  Allowed MIME Types: ${
          b.allowed_mime_types ? b.allowed_mime_types.join(", ") : "Any"
        }\n`
      );
    });
  } catch (e) {
    logError(`Unexpected error listing buckets: ${e.message}`);
  }
}

async function showBucketFiles() {
  console.clear();
  log(COLORS.blue, "===", `LIST FILES IN BUCKET ===\n`);
  const bucketName = await ask("Enter bucket name:");
  if (!bucketName) {
    logError("Bucket name required.");
    return;
  }
  const prefix = await ask(
    "Enter path prefix (optional, e.g., 'folder/subfolder'):"
  );

  logInfo(`Listing files in '${bucketName}' (prefix: '${prefix || "/"}')...`);
  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(prefix || "", {
        limit: 100, // Example: add options if needed
        offset: 0,
        // sortBy: { column: 'name', order: 'asc' }, // Example
      });
    if (error) {
      logError(`Failed to list files: ${error.message}`);
      logTip(getErrorHint(error));
      return;
    }
    if (!data.length) {
      logWarn("No files or folders found at this location.");
      return;
    }
    logSuccess(`Found ${data.length} items:\n`);
    data.forEach((item) => {
      const isDir = !item.id;
      const itemName = `${isDir ? "📁" : "📄"} ${item.name}`;
      const itemMeta = isDir
        ? "(Directory)"
        : `(${formatBytes(item.metadata?.size || 0)}, MIME: ${
            item.metadata?.mimetype || "N/A"
          })`;
      console.log(`${itemName} ${COLORS.dim}${itemMeta}${COLORS.reset}`);
      if (!isDir) {
        const { data: urlData } = supabase.storage
          .from(bucketName)
          .getPublicUrl((prefix ? prefix + "/" : "") + item.name);
        if (urlData?.publicUrl)
          console.log(
            `   ${COLORS.cyan}URL: ${urlData.publicUrl}${COLORS.reset}`
          );
      }
    });
  } catch (e) {
    logError(`Unexpected error listing files: ${e.message}`);
  }
}

async function checkDownload() {
  console.clear();
  log(COLORS.blue, "===", `DOWNLOAD TEST ===\n`);
  const bucketName = await ask("Enter bucket name:");
  if (!bucketName) {
    logError("Bucket name required.");
    return;
  }
  const filePath = await ask("Enter full file path in bucket:");
  if (!filePath) {
    logError("File path required.");
    return;
  }

  logInfo(
    `\n1. Attempting download via Supabase client: ${bucketName}/${filePath}`
  );
  const startTime = Date.now();
  try {
    const { data: blob, error } = await supabase.storage
      .from(bucketName)
      .download(filePath);
    if (error) {
      logError(`Download FAILED: ${error.message}`);
      logTip(getErrorHint(error));
    } else {
      const duration = Date.now() - startTime;
      logSuccess(
        `Download SUCCEEDED in ${duration}ms. Size: ${formatBytes(
          blob.size
        )}, Type: ${blob.type}`
      );
      const dlPath = path.join(
        TEMP_DIR_PATH,
        `download_${path.basename(filePath)}`
      );
      fs.writeFileSync(dlPath, Buffer.from(await blob.arrayBuffer()));
      logInfo(`File saved locally to: ${dlPath} (for inspection)`);
    }
  } catch (e) {
    logError(`Critical download exception: ${e.message}`);
  }

  logInfo("\n2. Checking public URL accessibility (if any):");
  const { data: urlData } = supabase.storage
    .from(bucketName)
    .getPublicUrl(filePath);
  if (urlData?.publicUrl) {
    logInfo(`Public URL: ${urlData.publicUrl}`);
    const publicUrlCheck = await checkUrl(urlData.publicUrl);
    if (publicUrlCheck.accessible)
      logSuccess(
        `Public URL accessible (Status: ${publicUrlCheck.statusCode}).`
      );
    else
      logWarn(
        `Public URL check (Status: ${publicUrlCheck.statusCode}, Error: ${
          publicUrlCheck.error || "N/A"
        }). RLS/CORS/private bucket?`
      );
  } else {
    logWarn("Could not retrieve public URL for this file.");
  }
}

async function fullDiagnostics() {
  console.clear();
  log(COLORS.blue, "===", `ADVANCED DIAGNOSTICS ===\n`);

  log(COLORS.bright, "1.", `Environment & Client Status`);
  const supUrl = process.env[ENV_SUPABASE_URL];
  const hasServKey = !!process.env[ENV_SERVICE_KEY];
  const hasAnonKey = !!process.env[ENV_ANON_KEY];
  console.log(
    `   ${ENV_SUPABASE_URL}: ${
      supUrl
        ? `${COLORS.green}SET (${supUrl})${COLORS.reset}`
        : `${COLORS.red}NOT SET${COLORS.reset}`
    }`
  );
  console.log(
    `   ${ENV_SERVICE_KEY}: ${
      hasServKey
        ? `${COLORS.green}SET${COLORS.reset}`
        : `${COLORS.yellow}NOT SET${COLORS.reset}`
    }`
  );
  console.log(
    `   ${ENV_ANON_KEY}: ${
      hasAnonKey
        ? `${COLORS.green}SET${COLORS.reset}`
        : `${COLORS.yellow}NOT SET${COLORS.reset}`
    }`
  );
  console.log(
    `   Using Key: ${
      hasServKey
        ? "Service Role (Optimal)"
        : hasAnonKey
        ? "Anon Key (Limited)"
        : "NONE (Critical!)"
    }`
  );
  if (supabase) logSuccess(`   Supabase client: Initialized.`);
  else logError(`   Supabase client: NOT Initialized.`);

  log(COLORS.bright, "\n2.", `Bucket Overview & Basic Permissions`);
  try {
    const { data: buckets, error: bError } =
      await supabase.storage.listBuckets();
    if (bError) logError(`   Bucket listing failed: ${bError.message}`);
    else if (!buckets.length) logWarn("   No buckets found.");
    else {
      logSuccess(`   Found ${buckets.length} buckets. Testing basic ops:`);
      for (const bucket of buckets) {
        console.log(
          `   - Bucket: ${COLORS.bright}${bucket.name}${
            COLORS.reset
          } (Public: ${bucket.public ? "Yes" : "No"})`
        );
        const { data: files, error: fError } = await supabase.storage
          .from(bucket.name)
          .list("", { limit: 1 });
        if (fError)
          logWarn(
            `     List files in '${bucket.name}': FAILED (${fError.message})`
          );
        else
          logSuccess(
            `     List files in '${bucket.name}': OK (${files.length} items at root)`
          );
      }
    }
  } catch (e) {
    logError(`   Bucket ops error: ${e.message}`);
  }

  log(
    COLORS.bright,
    "\n3.",
    `Storage Upload/Download Permission Test (using first available bucket)`
  );
  const { data: bucketsList } = await supabase.storage.listBuckets();
  const targetBucket = bucketsList?.[0]?.name;

  if (targetBucket) {
    logInfo(`   Using bucket '${targetBucket}' for R/W test.`);
    const testFile = await prepareTestFile("text");
    if (testFile) {
      const testPath = `${DEFAULT_UPLOAD_PATH_PREFIX}/diagnostics-rw-test.txt`;
      const uploadResultPath = await coreUploadProcessor(
        targetBucket,
        testPath,
        { path: testFile.filePath },
        testFile.contentType,
        testFile.fileSize
      );
      if (uploadResultPath) {
        logInfo(
          `   Attempting to download test file: ${targetBucket}/${testPath}`
        );
        const { error: dlError } = await supabase.storage
          .from(targetBucket)
          .download(testPath);
        if (dlError)
          logError(`     Download test: FAILED (${dlError.message})`);
        else logSuccess(`     Download test: OK`);

        logInfo(
          `   Attempting to delete test file: ${targetBucket}/${testPath}`
        );
        const { error: rmError } = await supabase.storage
          .from(targetBucket)
          .remove([testPath]);
        if (rmError)
          logWarn(
            `     Delete test: FAILED (${rmError.message}). Manual cleanup may be needed.`
          );
        else logSuccess(`     Delete test: OK`);
      } else {
        logError(
          `   Upload portion of R/W test failed for bucket '${targetBucket}'.`
        );
      }
      try {
        fs.unlinkSync(testFile.filePath);
      } catch {}
    } else {
      logError("   Could not prepare test file for R/W diagnostics.");
    }
  } else {
    logWarn("   No buckets available to perform R/W permission test.");
  }

  log(COLORS.bright, "\n4.", `CORS/Public URL Check`);
  if (supUrl) {
    const storagePublicTestUrl = `${supUrl}/storage/v1/object/public/${
      targetBucket || "test-bucket"
    }/nonexistent-test-file.txt`;
    logInfo(`   Pinging sample public URL: ${storagePublicTestUrl}`);
    const { statusCode, error: urlErr } = await checkUrl(storagePublicTestUrl);
    if (statusCode === 404) {
      // 404 is expected for a non-existent file if endpoint is reachable
      logSuccess(
        `   Public URL endpoint seems responsive (expected 404 for test file).`
      );
    } else if (statusCode > 0) {
      logWarn(
        `   Public URL endpoint check returned status ${statusCode}. Might indicate CORS/config issues.`
      );
    } else {
      logError(
        `   Public URL endpoint check FAILED (Error: ${
          urlErr || "Unknown"
        }). Likely CORS or network issue.`
      );
    }
    logTip(
      "   Ensure your Supabase project's CORS settings (Dashboard > Project Settings > API > Storage) include your origin or '*' for testing."
    );
  } else {
    logWarn(
      "   Supabase URL not set, cannot perform full CORS/Public URL check."
    );
  }
}

const menuActions = {
  1: { description: "Connection & Config Test", func: checkConnectivity },
  2: { description: "List Buckets", func: showBuckets },
  3: {
    description: "Upload Test (Generated Text File)",
    func: () => handleGeneratedFileUpload("text"),
  },
  4: {
    description: "Upload Test (Generated Image File)",
    func: () => handleGeneratedFileUpload("image"),
  },
  5: {
    description: "Upload Test (Custom Local File)",
    func: handleCustomFileUpload,
  },
  6: { description: "List Files in Bucket", func: showBucketFiles },
  7: { description: "Download Test", func: checkDownload },
  8: { description: "Full Diagnostics", func: fullDiagnostics },
  9: {
    description: "Exit",
    func: () => {
      log(COLORS.blue, "===", "Exiting Supabase Storage Debug Tool. ===");
      rl.close();
      if (fs.existsSync(TEMP_DIR_PATH)) {
        try {
          fs.rmSync(TEMP_DIR_PATH, { recursive: true, force: true });
          logInfo("Temporary directory cleaned up.");
        } catch (e) {
          logWarn(
            `Could not fully clean up temp directory ${TEMP_DIR_PATH}: ${e.message}`
          );
        }
      }
    },
  },
};

async function mainLoop() {
  console.clear();
  log(COLORS.blue, "===", "SUPABASE STORAGE DEBUGGER v1.0 ===");
  log(COLORS.bright, "\nSelect an operation:", COLORS.reset);
  Object.entries(menuActions).forEach(([key, { description }]) => {
    console.log(`${COLORS.yellow}${key}.${COLORS.reset} ${description}`);
  });

  const choice = await ask("\nYour choice:");
  const selectedAction = menuActions[choice];

  if (selectedAction) {
    await selectedAction.func();
    if (choice !== "9") {
      await pressEnterToContinue();
      await mainLoop();
    }
  } else {
    logWarn("Invalid selection. Try again.");
    await pressEnterToContinue();
    await mainLoop();
  }
}

async function start() {
  console.clear();
  log(COLORS.blue, "🚀", "Supabase Storage Debug Tool Initializing...");
  if (!(await validateEnvAndInitClient())) {
    logError(
      "Setup failed. Cannot proceed. Please check your .env file and Supabase project status."
    );
    rl.close();
    return;
  }
  await mainLoop();
}

start().catch((error) => {
  console.error(
    `${COLORS.bgRed}${COLORS.bright}FATAL UNHANDLED EXCEPTION:${COLORS.reset}`
  );
  console.error(error);
  rl.close();
});
