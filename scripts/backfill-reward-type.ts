/**
 * One-off, idempotent backfill: stamp `rewardType: 'cash'` and a derived
 * `points` onto bounties created before the cash/custom reward feature.
 *
 * The app already treats an absent `rewardType` as 'cash' (see mapBounty and
 * firestore.rules), so this is OPTIONAL — running it just makes the stored data
 * explicit and lets future code stop relying on the read-time default. It does
 * not change any leaderboard math: `points` is set to the existing dollar price,
 * which is exactly what approve/reject already award for legacy docs.
 *
 * Usage (uses Application Default Credentials; collectionGroup needs admin):
 *   # dry run — prints what WOULD change, writes nothing (default):
 *   GOOGLE_CLOUD_PROJECT=bounty-c5ee6 npx ts-node scripts/backfill-reward-type.ts
 *   # apply:
 *   GOOGLE_CLOUD_PROJECT=bounty-c5ee6 npx ts-node scripts/backfill-reward-type.ts --apply
 *
 * Idempotent: docs that already have a `rewardType` are skipped, so re-running
 * is safe. Only `rewardType`/`points` are touched — never price, state, etc.
 */
import * as admin from "firebase-admin";

const APPLY = process.argv.includes("--apply");

admin.initializeApp();
const db = admin.firestore();

async function main(): Promise<void> {
  // All bounties live in groups/{gid}/bounties/{bid}; a collection-group query
  // sweeps every group in one pass.
  const snap = await db.collectionGroup("bounties").get();

  let scanned = 0;
  let toUpdate = 0;
  const writer = db.bulkWriter();

  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data();
    // Idempotent: anything already migrated (or created post-feature) is skipped.
    if (data.rewardType !== undefined) continue;

    const price = typeof data.price === "number" ? data.price : 0;
    const patch = {
      rewardType: "cash" as const,
      // Mirror the read-time default: legacy points = dollar price (1:1).
      points: typeof data.points === "number" ? data.points : price,
    };
    toUpdate++;

    if (APPLY) {
      void writer.set(doc.ref, patch, {merge: true});
    } else {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] ${doc.ref.path} → ${JSON.stringify(patch)}`);
    }
  }

  if (APPLY) await writer.close();

  // eslint-disable-next-line no-console
  console.log(
      `${APPLY ? "Applied" : "Dry run"}: scanned ${scanned}, ` +
      `${toUpdate} ${APPLY ? "updated" : "would be updated"}.`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
