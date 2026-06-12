import type { AnalysisInput, AnalysisResult } from '@delfini/drift-engine'

export interface AnalysisOrchestrator {
  analyze(input: AnalysisInput): Promise<AnalysisResult>
}
