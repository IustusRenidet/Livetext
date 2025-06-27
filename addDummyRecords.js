const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('livetext');


    const collections = [
      'resources',
      'form_submissions',
      'educational_resources',
      'newsletter_subscribers',
      'documents',
      'templates',
      'comments',
      'posts',
      'events'
    ];

    for (const name of collections) {
      const result = await db.collection(name).insertOne({
        seededAt: new Date(),
        dummy: true
      });
      console.log(`Inserted into ${name}: ${result.insertedId}`);
=======
    const collections = await db.collections();
    for (const coll of collections) {
      await coll.insertOne({ dummyRecord: true, insertedAt: new Date() });
      console.log(`Inserted dummy record into ${coll.collectionName}`);

    }
  } catch (err) {
    console.error('Error inserting dummy records:', err);
  } finally {
    await client.close();
  }
}

main();
