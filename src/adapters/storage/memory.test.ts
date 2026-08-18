import { inMemoryStores } from './memory.ts';
import { describeStorageContract } from './storage-contract.ts';

describeStorageContract('in-memory', async () => ({ stores: inMemoryStores() }));
