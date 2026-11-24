import { createModelSelection } from "@t3tools/shared/model";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { initializeComposerOffsets } from "./composer-native-offsets";
import { mergeComposerDraftStates } from "./composerDraftStore";

it("matches the TS draft oracle for clears, absence and every field-group conflict", async () => {
  vi.stubEnv("VITE_T3_CODE_LS_DRAFT_RECONCILIATION", "rust");
  await initializeComposerOffsets();
  try {
    const empty = { prompt: "", attachments: [] };
    const variants = [undefined, empty, { ...empty, prompt: "雪🐟" },
      { ...empty, runtimeMode: "full-access" as const },
      { ...empty, interactionMode: "plan" as const },
      { ...empty, prompt: "t3-context://terminal/opaque", terminalContexts: [{ id: "opaque", threadId: ThreadId.make("opaque-thread"), createdAt: "2026-01-01T00:00:00Z", terminalId: "terminal", terminalLabel: "Terminal", lineStart: 1, lineEnd: 2, text: "雪🐟" }] },
      { ...empty, activeProvider: null },
      { ...empty, modelSelectionExplicit: true,
        modelSelectionByProvider: { codex: createModelSelection(ProviderInstanceId.make("codex"), "fixture-model") } }];
    for (const stored of variants) for (const local of variants) for (const baseline of variants) {
      const state = (draft: typeof stored) => ({
        draftsByThreadKey: draft === undefined ? {} : { "env:exact:draft": draft },
        draftThreadsByThreadKey: {}, logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      });
      vi.stubEnv("VITE_T3_CODE_LS_DRAFT_RECONCILIATION", "typescript");
      const expected = mergeComposerDraftStates(state(stored), state(local), state(baseline));
      vi.stubEnv("VITE_T3_CODE_LS_DRAFT_RECONCILIATION", "rust");
      expect(mergeComposerDraftStates(state(stored), state(local), state(baseline))).toEqual(expected);
    }
    expect(performance.getEntriesByName("t3-composer-rust-draft-reconciliation").length).toBeGreaterThan(0);
  } finally { vi.unstubAllEnvs(); }
});
