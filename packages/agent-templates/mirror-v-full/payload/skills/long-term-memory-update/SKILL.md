---
name: "long-term-memory-update"
description: "Write long-term memory, refresh its index, and verify retrieval after durable-memory requests."
---

# Long-Term Memory Update

## Procedure

1. Search the memory corpus for the requested fact, decision, or operating rule; reuse or extend the closest durable record instead of creating a duplicate, and finish when the intended destination is identified.
2. Write the durable detail into a specific non-core file under `memory/`; when an earlier diagnosis or decision is directly related, add a short dated follow-up and link to the detailed record, and finish when both facts form one retrievable chain.
3. If the change would touch a protected core memory document, show the exact diff and wait for approval rather than editing it, and finish when approval is obtained or a non-core destination is used.
4. Run the available incremental memory-index rebuild for the target agent after the file write, and finish only when the rebuild completes without error.
5. Query `memory_search` using distinctive terms from the new record; finish only when the new file is returned with the expected facts. If the file is absent, rebuild the index once and repeat the verification before reporting completion.
6. Report the written path, any related record updated, and the successful retrieval check; do not claim the item is in long-term memory based only on file existence.
