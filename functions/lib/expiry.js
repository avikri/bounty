"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBountyExpiry = runBountyExpiry;
/** Each expired bounty contributes 2 writes (doc + activity event). */
const EXPIRY_BATCH_LIMIT = 400;
/**
 * Expire every bounty still `available` or `claimed` whose `expiresAt` is
 * before `now`. Marks them `expired`, stamps `resolvedAt`, and appends a
 * `kind:'expired'` activity event authored by `system`. No points change and
 * no notifications — expiry is not a penalty.
 *
 * @returns the number of bounties expired.
 */
async function runBountyExpiry(db, now) {
    // Firestore can't combine an `in` on state with a range on expiresAt
    // cheaply, so we run the two state queries and merge the results.
    const [availSnap, claimedSnap] = await Promise.all([
        db.collectionGroup("bounties")
            .where("state", "==", "available")
            .where("expiresAt", "<", now)
            .get(),
        db.collectionGroup("bounties")
            .where("state", "==", "claimed")
            .where("expiresAt", "<", now)
            .get(),
    ]);
    const docs = [...availSnap.docs, ...claimedSnap.docs];
    if (docs.length === 0)
        return 0;
    let expired = 0;
    for (let i = 0; i < docs.length; i += EXPIRY_BATCH_LIMIT) {
        const batch = db.batch();
        const slice = docs.slice(i, i + EXPIRY_BATCH_LIMIT);
        for (const doc of slice) {
            batch.update(doc.ref, { state: "expired", resolvedAt: now });
            const actRef = doc.ref.collection("activity").doc();
            batch.set(actRef, { kind: "expired", actorId: "system", at: now });
        }
        await batch.commit();
        expired += slice.length;
    }
    return expired;
}
//# sourceMappingURL=expiry.js.map