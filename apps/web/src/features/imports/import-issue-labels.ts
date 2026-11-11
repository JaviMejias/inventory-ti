export const importIssueLabels: Record<string, string> = {
  MISSING_SHEET: 'Falta una hoja esperada', UNKNOWN_SHEET: 'Hoja sin reglas de interpretación', HEADER_MISMATCH: 'Encabezado distinto del esperado', UNMAPPED_COLUMN: 'Columna sin interpretación',
  FORMULA_REQUIRES_REVIEW: 'Fórmula pendiente de revisión', EXCEL_CELL_ERROR: 'Celda con error de Excel', NUMERIC_SERIAL_REQUIRES_REVIEW: 'Serie numérica: identidad no confirmada',
  NUMERIC_TAG_PRECISION_RISK: 'Activo fijo numérico con riesgo de pérdida de precisión', NUMERIC_TAG_FORMAT_REQUIRES_REVIEW: 'Formato numérico del activo fijo por revisar',
  IDENTIFIER_TYPE_REQUIRES_REVIEW: 'Tipo de identificador no confirmado', SOURCE_NOTE_NOT_ASSET: 'Nota aislada, no corresponde a un equipo', MISSING_ASSET_IDENTITY: 'Falta identidad utilizable',
  MISSING_PRODUCT_MODEL: 'Modelo incompleto', DATE_REQUIRES_REVIEW: 'Fecha ambigua o inválida', FUTURE_SOURCE_DATE: 'Fecha futura en el origen', SOURCE_DATE_ORDER_CONFLICT: 'Fechas en orden incompatible',
  RETIREMENT_DATE_UNCONFIRMED: 'Fecha efectiva de baja no confirmada', OPERATIONAL_STATE_UNRESOLVED: 'Estado operativo no confirmado', POSSIBLE_SHIFTED_STATE_COLUMN: 'Posible columna de estado desplazada',
  AVAILABILITY_ASSIGNMENT_CONFLICT: 'Disponibilidad incompatible con una entrega indicada', INVALID_IP_ADDRESS: 'Dirección IP inválida', NETWORK_PREFIX_IP_CONFLICT: 'IP distinta del prefijo de red',
  PRODUCT_BRAND_CONFLICT: 'Marcas incompatibles para la misma identidad', PRODUCT_MODEL_CONFLICT: 'Modelos incompatibles para la misma identidad', PRODUCT_EQUIPMENTTYPE_CONFLICT: 'Tipos de equipo incompatibles',
  SERIAL_HAS_MULTIPLE_TAGS: 'Serie asociada a varios activos fijos', TAG_HAS_MULTIPLE_SERIALS: 'Activo fijo asociado a varias series', CROSS_SHEET_STATE_CONFLICT: 'Estado contradictorio entre hojas',
  AMBIGUOUS_EXISTING_ASSET: 'Coincide con varios activos existentes', EXISTING_SERIAL_CONFLICT: 'Serie incompatible con la coincidencia existente', EXISTING_TAG_CONFLICT: 'Activo fijo incompatible con la coincidencia existente',
  EXISTING_TERMINAL_STATE_CONFLICT: 'Fuente disponible para un activo inactivo o dado de baja', MULTIPLE_SOURCE_OBSERVATIONS: 'Varias observaciones de la misma identidad',
  CONSUMABLE_UNIT_UNCONFIRMED: 'Unidad de consumible pendiente de definir', MANUAL_SUMMARY_NOT_STOCK: 'Resumen manual, no acredita stock'
};
