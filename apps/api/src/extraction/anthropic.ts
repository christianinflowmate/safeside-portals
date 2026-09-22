import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  ExtractionResultSchema,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
} from '@safeside/shared';
import {
  ExtractionError,
  type ExtractionInput,
  type ExtractionOutcome,
  type ExtractionProvider,
} from './provider.ts';

const TOOL_NAME = 'extract_quote';

/**
 * The tool schema is generated from the same zod schema used to validate the
 * response, so the model is never asked for a shape we would then reject.
 *
 * `io: 'input'` matters: fields carrying `.default()` are optional on the way in
 * (the model may omit an empty array) but guaranteed present after parsing.
 */
const TOOL_SCHEMA = z.toJSONSchema(ExtractionResultSchema, {
  target: 'draft-7',
  io: 'input',
});

export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  // Note: fields are declared and assigned explicitly rather than using TypeScript
  // parameter properties. Node runs .ts directly in strip-only mode, which rejects
  // parameter properties, enums and namespaces — see docs/typescript.md.
  constructor(apiKey: string, model: string = 'claude-sonnet-5') {
    if (!apiKey) throw new ExtractionError('ANTHROPIC_API_KEY is not set');
    this.model = model;
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  async extract({ pdf, filename }: ExtractionInput): Promise<ExtractionOutcome> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        /*
         * No temperature here: this model rejects the parameter outright
         * ("`temperature` is deprecated for this model"), and setting it fails
         * every request.
         *
         * Extraction therefore varies slightly between runs on the same
         * document — one pass found an excess liability line another did not.
         * That is a real property of the tool, not something we can switch off,
         * so the golden eval tolerates small drift and flags only what matters:
         * a premium disappearing, a line vanishing, a large drop in detail count.
         */
        system: EXTRACTION_SYSTEM_PROMPT,
        tools: [
          {
            name: TOOL_NAME,
            description:
              'Return the structured contents of this carrier quote. Call exactly once.',
            input_schema: TOOL_SCHEMA as Anthropic.Tool['input_schema'],
          },
        ],
        // Force the tool so we always get structured output back, never prose.
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: Buffer.from(pdf).toString('base64'),
                },
                // Lets the model cite page numbers, which drives the "where did
                // this come from?" affordance on the review screen.
                citations: { enabled: true },
              },
              { type: 'text', text: buildExtractionUserPrompt(filename) },
            ],
          },
        ],
      });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      // 429 and 5xx are worth another attempt; 400 means this document will never
      // parse and retrying just burns tokens.
      const retryable = status === 429 || (status !== undefined && status >= 500);
      throw new ExtractionError(
        `Anthropic request failed for ${filename}`,
        err,
        retryable,
      );
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === TOOL_NAME,
    );

    if (!toolUse) {
      throw new ExtractionError(
        `Model returned no ${TOOL_NAME} call for ${filename} (stop_reason: ${response.stop_reason})`,
        response,
        response.stop_reason === 'max_tokens',
      );
    }

    const parsed = ExtractionResultSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new ExtractionError(
        `Model output failed validation for ${filename}: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
        { raw: toolUse.input, issues: parsed.error.issues },
        false,
      );
    }

    /*
     * A result with no lines AND no notes is a bad response, not a quiet
     * document.
     *
     * One run of a real quote came back exactly like this — zero lines, zero notes,
     * everything else empty — and was recorded as a success. The proposal then
     * carried one coverage line where it should have carried two, and nothing
     * anywhere said an $86,154 property line had gone missing. Re-running the
     * same file produced it correctly, so the model had simply answered badly
     * once.
     *
     * Retryable, so the worker has another go rather than accepting it. A
     * document that genuinely prices nothing will fail after the retries and
     * show up on the analyzing screen as a file the broker can drop — visible,
     * which silently losing a line is not. Extraction of a real quote always
     * produces one or the other: a line it priced, or a note saying why not.
     */
    if (parsed.data.lines.length === 0 && parsed.data.notes.length === 0) {
      throw new ExtractionError(
        `Model returned nothing at all for ${filename} — no coverage lines and no notes`,
        { raw: toolUse.input },
        true,
      );
    }

    return {
      result: parsed.data,
      raw: response,
      usage: {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
      model: response.model ?? this.model,
    };
  }
}
