import type { AnalysisOrchestrator } from '../ports/orchestrator.js'
import { SingleCallOrchestrator } from './single-call/orchestrator.js'

export const createOrchestrator = (): AnalysisOrchestrator => new SingleCallOrchestrator()
