import { JsonStore } from '../src/store.js';

const store = new JsonStore();
const data = await store.reset();
console.log(`Reset Demo data: ${data.projects.length} projects, ${data.members.length} members, ${data.subscriptions.length} subscriptions.`);
