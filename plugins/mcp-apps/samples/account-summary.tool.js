// A codeful MCP tool is a self-contained ESM module. The host injects dataApi and calls
// runTool({ toolInput, dataApi }); no host transport or Dataverse client is bundled here.

const FORMATTED_VALUE = "@OData.Community.Display.V1.FormattedValue";
const ACCOUNT_COLUMNS = ["accountid", "name", "revenue", "statecode"];

function readInput(toolInput) {
  const nameContains = toolInput.nameContains ?? "";
  const limit = toolInput.limit ?? 25;

  if (typeof nameContains !== "string") {
    throw new TypeError("nameContains must be a string");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }

  return { nameContains: nameContains.trim(), limit };
}

function escapeODataString(value) {
  // OData string literals escape an apostrophe by doubling it.
  return value.replaceAll("'", "''");
}

function shapeAccount(row) {
  return {
    id: row.accountid,
    name: row.name,
    revenue: row.revenue ?? null,
    status: row[`statecode${FORMATTED_VALUE}`] ?? "Unknown",
  };
}

async function queryAccounts(dataApi, nameContains, limit) {
  const filter = nameContains
    ? `contains(name,'${escapeODataString(nameContains)}')`
    : undefined;
  let page = await dataApi.queryTable("account", {
    select: ACCOUNT_COLUMNS,
    filter,
    orderBy: "name asc",
    pageSize: Math.min(limit, 25),
  });
  const rows = [...page.rows];

  while (rows.length < limit && page.hasMoreRows && page.loadMoreRows) {
    page = await page.loadMoreRows();
    rows.push(...page.rows);
  }

  return {
    rows: rows.slice(0, limit),
    hasMoreRows: rows.length > limit || page.hasMoreRows,
  };
}

export async function runTool({ toolInput, dataApi }) {
  const { nameContains, limit } = readInput(toolInput);

  try {
    const result = await queryAccounts(dataApi, nameContains, limit);
    const accounts = result.rows.map(shapeAccount);

    return {
      content: `Found ${accounts.length} matching account${accounts.length === 1 ? "" : "s"}.`,
      structuredContent: {
        accounts,
        totalCount: accounts.length,
        hasMoreRows: result.hasMoreRows,
      },
      // The host exposes authored `meta` to the widget as MCP `_meta`, outside model context.
      meta: {
        preferredView: "bar-chart",
        categoryField: "name",
        valueField: "revenue",
      },
    };
  } catch (error) {
    throw new Error("Could not load account summaries", { cause: error });
  }
}
