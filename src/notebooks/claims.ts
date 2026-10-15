import type { DevelopmentGarden } from "./garden.js";

export interface NotebookRunClaims {
	claim(runDocumentId: string, executionId: string, receipt: string): Promise<boolean>;
}

/** The Garden run document is the exclusive claim and durable intent. */
export class GardenNotebookRunClaims implements NotebookRunClaims {
	constructor(private readonly garden: DevelopmentGarden) {}

	async claim(runDocumentId: string, executionId: string, receipt: string): Promise<boolean> {
		let result: Record<string, unknown>;
		try {
			result = await this.garden.call(
				"create_document_once",
				{
					graph_id: this.garden.graphId,
					document_id: runDocumentId,
					title: `Run ${executionId}`,
					order: Date.now(),
					parentId: null,
					awaitDurable: true,
					requireDurable: true,
					tiptapJson: {
						type: "doc",
						content: [
							{
								type: "codeBlock",
								attrs: { "data-block-id": `${runDocumentId}-receipt`, language: "json" },
								content: [{ type: "text", text: receipt }],
							},
						],
					},
				},
				5 * 60_000,
			);
		} catch (error) {
			if (
				/create_document_once refused:.*(?:prior admission|document authority|document sidecar|hot workspace authority|workspace .* authority)/i.test(
					String(error),
				)
			)
				return false;
			throw error;
		}
		if (
			!result ||
			typeof result !== "object" ||
			result.outcome !== "created" ||
			result.durabilityChecked !== true ||
			(result.durability !== "published" && result.durability !== "local")
		)
			throw new Error("Garden did not confirm durable notebook run admission");
		return true;
	}
}
