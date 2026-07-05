import type { ImportKind } from "@/import/run-import";

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

/**
 * Every column each kind's CSV template uses (required or not) — used to
 * score how well an uploaded file's header row matches each kind, so a file
 * uploaded under the wrong "kind" selection (e.g. a Customers export picked
 * as "Products") can be caught before every row fails validation with
 * confusing per-field errors. Only required headers are a poor fingerprint
 * here: suppliers/customers (and supplier/customer addresses) each have only
 * "Name" (or "Name"+"AddressType") required, so the distinguishing signal is
 * in the optional-but-kind-specific columns (e.g. AccountPayable vs
 * AccountReceivable/SaleAccount/CreditLimit).
 */
const KIND_COLUMNS: Record<ImportKind, string[]> = {
  products: [
    "ProductCode",
    "Name",
    "Category",
    "Brand",
    "Type",
    "FixedAssetType",
    "CostingMethod",
    "Length",
    "Width",
    "Height",
    "Weight",
    "CartonLength",
    "CartonWidth",
    "CartonHeight",
    "CartonInnerQuantity",
    "CartonQuantity",
    "CartonVolume",
    "WeightUnits",
    "DimensionUnits",
    "Barcode",
    "MinimumBeforeReorder",
    "ReorderQuantity",
    "DefaultLocation",
    "LastSuppliedBy",
    "SupplierProductCode",
    "SupplierProductName",
    "SupplierFixedPrice",
    "DefaultUnitOfMeasure",
    "Status",
    "Description",
    "PurchaseTaxRule",
    "SaleTaxRule",
    ...numbered("PriceTier", 10),
    "AutoAssemble",
    "AutoDisassemble",
    "DropShip",
    "DropShipSupplier",
    "AverageCost",
    "InventoryAccount",
    "RevenueAccount",
    "ExpenseAccount",
    "COGSAccount",
    "ProductAttributeSet",
    ...numbered("AdditionalAttribute", 10),
    "DiscountName",
    "ProductFamilySKU",
    "ProductFamilyName",
    "ProductFamilyOption1Name",
    "ProductFamilyOption1Value",
    "ProductFamilyOption2Name",
    "ProductFamilyOption2Value",
    "ProductFamilyOption3Name",
    "ProductFamilyOption3Value",
    "CommaDelimitedTags",
    "StockLocator",
    "ShortDescription",
    "Sellable",
    "PickZones",
    "AlwaysShowQuantity",
    "WarrantySetupName",
    "InternalNote",
    "MakeToOrderBom",
    "IsAccountingDimensionEnabled",
    ...numbered("DimensionAttribute", 10),
    "HSCode",
    "CountryOfOrigin",
  ],
  assembly_bom: [
    "Action",
    "ProductSKU",
    "ProductName",
    "ComponentSKU",
    "ComponentName",
    "Quantity",
    "WastageQuantity_ForStockComponentOnly",
    "WastagePercent_ForStockComponentOnly",
    "CostPercentage_ForStockComponentOnly",
    "PriceTier_ForServiceComponentOnly",
    "ExpenseAccount_ForServiceComponentOnly",
    "EstimatedUnitCost",
  ],
  production_bom: [
    "Action",
    "ProductSKU",
    "ProductName",
    "QuantityToProduce",
    "BufferPercent",
    "ProductionInstructionUrl",
    "IgnoreCumulativeLeadTime",
    "ProductionLeadTime",
    "Version",
    "VersionName",
    "VersionDefault",
    "MinQuantity",
    "MaxQuantity",
    "DeviationPercent",
    "RunSize",
    "OperationSequence",
    "OperationType",
    "OperationName",
    "CycleTime",
    "UnitPerCycle",
    "WorkCentreCode",
    "WorkCentreName",
    "PreviousStep",
    "ItemType",
    "ComponentSKU_ResourceCode",
    "ComponentName_ResourceName",
    "Quantity",
    "WastageQuantity_ForStockComponentOnly",
    "WastagePercent_ForStockComponentOnly",
    "CostAllocationType",
    "SalesValue",
    "CostOfWastage",
    "DeliveryTo_LocationName",
    "DeliveryTo_BinName",
    "CoManPriceTier",
    "Tracing",
    "IssueMethodComponent",
    "IssueMethodParameter",
    "OperationIsBackflush",
    "ComponentIsBackflush",
    "ResourceCostType",
  ],
  suppliers: [
    "Name",
    "Status",
    "Currency",
    "PaymentTerm",
    "TaxRule",
    "AccountPayable",
    "Carrier",
    "Discount",
    "TaxNumber",
    "AttributeSet",
    ...numbered("AdditionalAttribute", 10),
    "Comments",
    "ContactName",
    "JobTitle",
    "Phone",
    "MobilePhone",
    "Fax",
    "Email",
    "Website",
    "ContactComment",
    "ContactDefault",
    "ContactIncludeInEmail",
    "IsAccountingDimensionEnabled",
    ...numbered("DimensionAttribute", 10),
  ],
  customers: [
    "Name",
    "Status",
    "Currency",
    "PaymentTerm",
    "TaxRule",
    "AccountReceivable",
    "SaleAccount",
    "PriceTier",
    "Discount",
    "CreditLimit",
    "Carrier",
    "SalesRepresentative",
    "Location",
    "TaxNumber",
    "Tags",
    "DisplayName",
    "IsLegalEntity",
    "ParentCustomer",
    "IsBillParent",
    "AttributeSet",
    ...numbered("AdditionalAttribute", 10),
    "Comments",
    "ContactName",
    "JobTitle",
    "Phone",
    "MobilePhone",
    "Fax",
    "Email",
    "Website",
    "ContactComment",
    "ContactDefault",
    "ContactIncludeInEmail",
    "MarketingConsent",
    "IsAccountingDimensionEnabled",
    ...numbered("DimensionAttribute", 10),
  ],
  supplier_addresses: [
    "Action",
    "Name",
    "AddressType",
    "AddressDefaultForType",
    "AddressLine1",
    "AddressLine2",
    "City",
    "State",
    "Postcode",
    "Country",
  ],
  customer_addresses: [
    "Action",
    "Name",
    "AddressType",
    "AddressDefaultForType",
    "AddressLine1",
    "AddressLine2",
    "City",
    "State",
    "Postcode",
    "Country",
    "IsParent",
  ],
};

/** Exposed for tests — lets fixtures build a genuine 100%-match header row for a kind instead of guessing a plausible-looking subset. */
export { KIND_COLUMNS };

export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  products: "Products",
  assembly_bom: "Assembly BOM",
  production_bom: "Production BOM",
  suppliers: "Suppliers",
  supplier_addresses: "Supplier Addresses",
  customers: "Customers",
  customer_addresses: "Customer Addresses",
};

export interface KindMismatch {
  bestKinds: ImportKind[];
  bestScorePercent: number;
  selectedScorePercent: number;
}

// A kind whose score is within this margin of the top score counts as "tied
// best" — needed because some kind pairs (suppliers/customers,
// supplier_addresses/customer_addresses) share almost their entire column
// set, so a genuine file of one will still score close to 1.0 against the
// other.
const TIE_MARGIN = 0.05;
// Below this, the file doesn't clearly resemble any known template (e.g. a
// near-empty or malformed CSV) — not enough signal to accuse the user of
// picking the wrong kind.
const CONFIDENCE_THRESHOLD = 0.5;

/**
 * Compares an uploaded file's header row against every kind's known column
 * set. Returns null when the selected kind is a plausible (or tied-best)
 * match, or details of the better-matching kind(s) when it isn't — so
 * run-import.ts can fail fast with "this looks like a Customers file, not
 * Products" instead of letting every row fail schema validation.
 */
export function detectKindMismatch(headers: string[], selectedKind: ImportKind): KindMismatch | null {
  if (headers.length === 0) return null;
  const headerSet = new Set(headers);

  const scores = (Object.keys(KIND_COLUMNS) as ImportKind[]).map((kind) => {
    const columns = KIND_COLUMNS[kind];
    const matched = columns.filter((c) => headerSet.has(c)).length;
    return { kind, score: matched / columns.length };
  });

  const bestScore = Math.max(...scores.map((s) => s.score));
  if (bestScore < CONFIDENCE_THRESHOLD) return null;

  const bestKinds = scores.filter((s) => s.score >= bestScore - TIE_MARGIN).map((s) => s.kind);
  if (bestKinds.includes(selectedKind)) return null;

  const selectedScore = scores.find((s) => s.kind === selectedKind)?.score ?? 0;
  return {
    bestKinds,
    bestScorePercent: Math.round(bestScore * 100),
    selectedScorePercent: Math.round(selectedScore * 100),
  };
}
