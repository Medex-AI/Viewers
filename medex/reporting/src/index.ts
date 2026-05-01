import { Types } from '@ohif/core';

// Pipeline: ConversationalAgent → MetricsSummary → AIDraftForm → HumanReview → TemplateReport
const MedExReportingExtension: Types.Extensions.Extension = {
  id: '@medex/reporting',
};

export default MedExReportingExtension;
