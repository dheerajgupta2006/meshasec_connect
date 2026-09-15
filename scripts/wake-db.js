/**
 * Wakes a suspended Neon compute before a migration runs.
 *
 * Neon scales an idle branch to zero, and the first connection after that takes
 * a few seconds. The Prisma migration engine does not honour `connect_timeout`,
 * so it fails outright with P1001 instead of waiting. Opening one cheap query
 * first gets the compute running, then the migration connects to a warm database.
 *
 * Retries because the wake itself can land during the cold start.
 */
const { PrismaClient } = require("@prisma/client");

const ATTEMPTS = 6;
const DELAY_MS = 3000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const prisma = new PrismaClient();

  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        await prisma.$queryRawUnsafe("SELECT 1");
        console.log(`DB awake (attempt ${attempt})`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`attempt ${attempt} failed: ${message.split("\n")[0]}`);

        if (attempt < ATTEMPTS) {
          await wait(DELAY_MS);
        }
      }
    }

    // Exit 0 regardless: this is a best-effort warm-up, and the migration that
    // follows is what actually needs to succeed or fail loudly.
    console.log("could not confirm the database is awake");
  } finally {
    await prisma.$disconnect();
  }
}

main();
