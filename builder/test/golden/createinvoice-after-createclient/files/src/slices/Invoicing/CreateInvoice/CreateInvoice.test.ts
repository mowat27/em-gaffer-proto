import {DeciderSpecification} from '@event-driven-io/emmett';
import {describe, it} from 'node:test';
import type {ClientCreated} from '../InvoicingEvents';
import {
    type CreateInvoiceCommand,
    CreateInvoiceInitialState,
    decide,
    evolve,
} from './CreateInvoiceCommand';

const rejectedWith = (code: string) => (error: Error) => (error as Error & {code?: string}).code === code;

describe('CreateInvoice Specification', () => {
    const given = DeciderSpecification.for({
        decide,
        evolve,
        initialState: CreateInvoiceInitialState,
    });

    it('spec: Create an invoice', () => {
        // BUILD: test data. The specification gives no example for amount and date: replace the placeholders with values that fit it.
        // BUILD: test data. ClientCreated is defined by another slice: fill its data with the fields of its type.
        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId: '00000000-0000-4000-8000-000000000001',
                clientId: '00000000-0000-4000-8000-000000000002',
                amount: 1,
                date: '2026-01-01',
            },
            metadata: {},
        };

        given([
            {
                type: 'ClientCreated',
                data: {} as ClientCreated['data'],
                metadata: {},
            },
        ])
            .when(command)
            .then([
                {
                    type: 'InvoiceCreated',
                    data: {
                        invoiceId: '00000000-0000-4000-8000-000000000001',
                        clientId: '00000000-0000-4000-8000-000000000002',
                        amount: 1,
                        date: '2026-01-01',
                    },
                    metadata: {},
                },
            ]);
    });

    it('spec: Unknown client is rejected', () => {
        // BUILD: test data. Give the command values that break only "Unknown client is rejected" (Client does not exist).
        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId: '00000000-0000-4000-8000-000000000001',
                clientId: '00000000-0000-4000-8000-000000000002',
                amount: 1,
                date: '2026-01-01',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows(rejectedWith('unknown_client_is_rejected'));
    });

    it('spec: Zero amount is rejected', () => {
        // BUILD: test data. Give the command values that break only "Zero amount is rejected" (Amount must be greater than zero).
        // BUILD: test data. ClientCreated is defined by another slice: fill its data with the fields of its type.
        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId: '00000000-0000-4000-8000-000000000001',
                clientId: '00000000-0000-4000-8000-000000000002',
                amount: 1,
                date: '2026-01-01',
            },
            metadata: {},
        };

        given([
            {
                type: 'ClientCreated',
                data: {} as ClientCreated['data'],
                metadata: {},
            },
        ])
            .when(command)
            .thenThrows(rejectedWith('zero_amount_is_rejected'));
    });
});
