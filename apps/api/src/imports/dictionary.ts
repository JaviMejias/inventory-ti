export type SheetKind = 'ASSET_OBSERVATION' | 'RETIREMENT_HISTORY' | 'CONSUMABLE_REVIEW' | 'MANUAL_SUMMARY' | 'SOURCE_NOTE' | 'UNMAPPED';
type Column = { field: string; header: string };
export type SheetMapping = { headerRow: number; kind: SheetKind; columns: Record<string, Column> };

function mapping(headerRow: number, kind: SheetKind, entries: string[]): SheetMapping {
  return { headerRow, kind, columns: Object.fromEntries(entries.map((entry) => {
    const [column, field, header] = entry.split('|');
    return [column, { field, header }];
  })) };
}

const reception = [
  'A|receivedDate|Fecha', 'B|incomingOt|OT Recepción', 'C|equipmentType|Equipo', 'D|brand|Marca', 'E|model|Modelo',
  'F|serialNumber|Serie', 'G|assetTag|Activo', 'H|incomingTicket|Ticket MDA', 'I|location|Ubicación',
  'J|technicalCondition|Estado', 'K|availability|Descripción', 'L|notes|Observación', 'M|usedDate|Fecha Utilizado',
  'N|outgoingTicket|Ticket MDA', 'O|outgoingOt|OT', 'P|details|Detalles'
];
const detached = [
  'A|receivedDate|Fecha', 'B|brand|Marca', 'C|model|Modelo', 'D|serialNumber|Serie', 'E|assetTag|Activo Fijo',
  'F|description|Descripción', 'G|sector|Sector', 'H|mixedState|Estado', 'I|usedDate|Fecha Utilizado',
  'J|outgoingTicket|Ticket MDA', 'K|outgoingOt|OT', 'L|details|Detalles'
];

// The same header has different meanings across sheets. Never map Estado globally.
export const sheetDictionary: Record<string, SheetMapping> = {
  'Baja 2026': mapping(1, 'RETIREMENT_HISTORY', [
    'A|receivedDate|Fecha', 'B|equipmentType|Equipo', 'C|brand|Marca', 'D|model|Modelo', 'E|serialNumber|Serie',
    'F|assetTag|Activo', 'G|incomingTicket|Ticket MDA', 'H|location|Ubicación', 'I|mixedState|Estado', 'J|description|Descripción', 'K|notes|Observación'
  ]),
  'Baja 2025': mapping(1, 'RETIREMENT_HISTORY', [
    ...reception.slice(0, 9), 'J|mixedState|Estado', 'K|description|Descripción', 'L|notes|Observación'
  ]),
  'NB Prestamo': mapping(2, 'ASSET_OBSERVATION', [
    'A|receivedDate|Fecha', 'B|loanCode|Equipo', 'C|equipmentType|Equipo', 'D|brand|Marca', 'E|model|Modelo', 'F|serialNumber|Serie',
    'G|availability|Estado', 'H|loanDate|Fecha Prestamo', 'I|outgoingTicket|Ticket', 'J|recipientText|Usuario', 'K|agentText|Agente Responsable'
  ]),
  FORTIGATE: mapping(1, 'ASSET_OBSERVATION', [
    'A|networkPrefix|IP Adress', 'B|ipAddress|IP', 'C|officeText|Oficina', 'D|serialNumber|Serie', 'E|assetTag|Activo', 'F|usagePurpose|Utilizado Por', 'G|notes|Obs'
  ]),
  'Control Desvinculados': mapping(4, 'ASSET_OBSERVATION', [
    ...detached.slice(0, 6), 'G|mixedState|Estado', 'H|usedDate|Fecha Utilizado', 'I|outgoingTicket|Ticket MDA', 'J|outgoingOt|OT', 'K|details|Detalles'
  ]),
  'Baja 2024': mapping(3, 'RETIREMENT_HISTORY', [
    'A|receivedDate|Fecha', 'B|brand|Marca', 'C|model|Modelo', 'D|serialNumber|Serie', 'E|description|Descripción', 'F|assetTag|Activo Fijo', 'G|notes|Observación'
  ]),
  'Bodega 2': mapping(3, 'ASSET_OBSERVATION', [
    ...reception.slice(0, 8), 'I|sector|Sector', 'J|mixedState|Estado', 'K|usagePurpose|Descripción', ...reception.slice(11)
  ]),
  'Bodega 1': mapping(3, 'ASSET_OBSERVATION', [
    ...reception.slice(0, 8), 'I|mixedState|Estado', 'J|usagePurpose|Descripción', 'K|notes|Observación',
    'L|usedDate|Fecha Utilizado', 'M|outgoingTicket|Ticket MDA', 'N|outgoingOt|OT Envio', 'O|details|Detalles'
  ]),
  'Recepción': mapping(3, 'ASSET_OBSERVATION', reception),
  Tintas: mapping(3, 'CONSUMABLE_REVIEW', [
    'A|receivedDate|Fecha', 'B|guideReference|Guía', 'C|printerSerial|Serie', 'D|color|Color', 'E|ipAddress|IP',
    'F|location|Ubicación', 'G|availability|Estado', 'H|outgoingTicket|Ticket', 'I|notes|Observación'
  ]),
  Desvinculados: mapping(4, 'ASSET_OBSERVATION', detached),
  'Caja Negra': mapping(4, 'ASSET_OBSERVATION', [
    ...detached.slice(0, 4), 'E|description|Descripción', 'F|assetTag|Activo Fijo', 'G|sector|Sector', 'H|technicalCondition|Estado',
    'I|notes|Observación', 'J|usedDate|Fecha Utilizado', 'K|outgoingTicket|Ticket MDA', 'L|outgoingOt|OT', 'M|details|Detalles'
  ]),
  'KIT CONTINGENCIA': mapping(1, 'ASSET_OBSERVATION', reception),
  CE: mapping(3, 'ASSET_OBSERVATION', [
    ...reception.slice(0, 9), 'J|availability|Descripción', 'K|usagePurpose|Estado', 'L|notes|Observación',
    'M|obsolescenceText|Periodo de Obsolenscia MM/YY', 'N|usedDate|Fecha Utilizado', 'O|outgoingTicket|Ticket MDA',
    'P|outgoingOt|OT', 'Q|details|Detalles', 'R|recipientText|Asignado a'
  ]),
  Transitorio: mapping(2, 'ASSET_OBSERVATION', [
    ...reception.slice(0, 7), 'H|location|Ubicación', 'I|mixedState|Estado', 'J|usagePurpose|Descripción', 'K|notes|Observación',
    'L|usedDate|Fecha Utilizado', 'M|outgoingTicket|Ticket MDA', 'N|outgoingOt|OT', 'O|details|Detalles', 'P|hostname|Nombre Maquina'
  ]),
  Disponible: mapping(2, 'MANUAL_SUMMARY', [
    'B|equipmentType|Equipo', 'C|newCount|Alta', 'D|replacementCount|Reposición (Nuevo)', 'E|usedCount|Usado'
  ]),
  'Inventario MDA 2': mapping(5, 'ASSET_OBSERVATION', [
    'B|receivedDate|Fecha', 'C|incomingOt|OT Recepción', 'D|equipmentType|Equipo', 'E|brand|Marca', 'F|model|Modelo',
    'G|serialNumber|Serie', 'H|assetTag|Activo', 'I|mixedState|Estado', 'J|purchaseOrder|OC', 'K|description|Descripcion'
  ])
};
