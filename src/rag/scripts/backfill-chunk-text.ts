/**
 * Backfill script: Populate chunkText from snippet for existing embeddings.
 *
 * For embeddings that were created before the chunkText field existed,
 * this copies the snippet (max 500 chars) into chunkText so they are
 * returned by Atlas Vector Search projections.
 *
 * For BEST quality, re-process expedientes so full chunk text (1500 chars)
 * is stored. This script is a quick stopgap that ensures old embeddings
 * still work with the new RAG pipeline.
 *
 * Usage (from project root):
 *   npx ts-node -r tsconfig-paths/register src/rag/scripts/backfill-chunk-text.ts
 *
 * Or call from the NestJS app via a one-time admin endpoint.
 */

import { connect, model, Schema } from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || '';

async function main() {
  if (!MONGO_URI) {
    console.error('Set MONGODB_URI or MONGO_URI env variable');
    process.exit(1);
  }

  await connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const EmbeddingSchema = new Schema({}, { strict: false, collection: 'embeddings' });
  const Embedding = model('EmbeddingMigration', EmbeddingSchema);

  // Find embeddings that have snippet but no chunkText
  const result = await Embedding.updateMany(
    {
      chunkText: { $exists: false },
      snippet: { $exists: true, $ne: null },
    },
    [
      {
        $set: {
          chunkText: '$snippet',
          chunkType: 'content',
        },
      },
    ],
  );

  console.log(`Updated ${result.modifiedCount} embeddings (backfilled chunkText from snippet)`);
  console.log('Done. For best quality, re-process expedientes to generate full 1500-char chunks.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
