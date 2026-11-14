import {DeciderSpecification} from '@event-driven-io/emmett';
import {
    CreateInvoiceCommand,
    CreateInvoiceInitialState,
    decide,
    evolve,
} from './CreateInvoiceCommand';
import {describe, it} from 'node:test';

describe('CreateInvoice Specification', () => {
    const given = DeciderSpecification.for({
        decide,
        evolve,
        initialState: CreateInvoiceInitialState,
    });

    // Assumption: spec "given" rows list events without field values; the
    // ClientCreated clientId is taken to match the command's clientId, and
    // example amounts/dates are sensible values (none in slice.json).
    const clientId = 'b7d70001-0000-4000-8000-000000000001';
    const invoiceId = 'bd0f0001-0000-4000-8000-000000000001';

    const clientCreated = {
        type: 'ClientCreated' as const,
        data: {
            clientId,
            name: 'Great GlenLtd',
            contactEmail: 'contact@greatglen.example',
        },
        metadata: {},
    };

    // spec: Create an invoice — given ClientCreated, when CreateInvoice, then InvoiceCreated
    it('spec: Create an invoice', () => {
        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId,
                clientId,
                amount: 100.5,
                date: '2026-11-14',
            },
            metadata: {},
        };

        given([clientCreated])
            .when(command)
            .then([{
                type: 'InvoiceCreated',
                data: {
                    invoiceId,
                    clientId,
                    amount: 100.5,
                    date: '2026-11-14',
                },
                metadata: {},
            }]);
    });

    // spec: Unknown client is rejected — "Client does not exist"
    it('spec: Unknown client is rejected', () => {
        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId,
                clientId: 'ffffffff-0000-4000-8000-00000000000f',
                amount: 100.5,
                date: '2026-11-14',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows();
    });

    // spec: Zero amount is rejected — "Amount must be greater than zero"
    it('spec: Zero amount is rejected', () => {
        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId,
                clientId,
                amount: 0,
                date: '2026-11-14',
            },
            metadata: {},
        };

        given([clientCreated])
            .when(command)
            .thenThrows();
    });
});
