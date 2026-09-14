import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

let extractor: FeatureExtractionPipeline | undefined;

export async function embed(text: string): Promise<number[]> {
  // First call downloads the ~80MB model once and caches it locally.
  extractor ??= await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}
