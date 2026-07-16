import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { buildQuickbooksSearchCriteria } from "../helpers/build-quickbooks-search-criteria.js";

export interface SearchCreditMemosInput {
  customer_ref?: string;
  txn_date_from?: string;
  txn_date_to?: string;
  limit?: number;
}

export async function searchQuickbooksCreditMemos(data: SearchCreditMemosInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();

    const filters: Array<Record<string, any>> = [];
    if (data.customer_ref) filters.push({ field: "CustomerRef", value: data.customer_ref });
    if (data.txn_date_from) filters.push({ field: "TxnDate", value: data.txn_date_from, operator: ">=" });
    if (data.txn_date_to) filters.push({ field: "TxnDate", value: data.txn_date_to, operator: "<=" });
    const criteria = buildQuickbooksSearchCriteria({ filters, limit: data.limit });

    return new Promise((resolve) => {
      (quickbooks as any).findCreditMemos(criteria, (err: any, result: any) => {
        if (err) {
          resolve({ result: null, isError: true, error: formatError(err) });
        } else {
          const memos = result?.QueryResponse?.CreditMemo || [];
          resolve({ result: memos, isError: false, error: null });
        }
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
