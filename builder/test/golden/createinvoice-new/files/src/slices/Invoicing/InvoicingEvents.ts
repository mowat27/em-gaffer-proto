import type {Event} from '@event-driven-io/emmett';

type CommonMeta = {
    correlation_id?: string;
    causation_id?: string;
    userId?: string;
};

export type InvoiceCreated = Event<'InvoiceCreated', {
    invoiceId: string;
    clientId: string;
    amount: number;
    date: string;
}, CommonMeta>;

// BUILD: event type. ClientCreated is used by the CreateInvoice specifications but defined by another slice: give it that slice's fields if src/slices/ has them, else the fields this slice reads from it.
export type ClientCreated = Event<'ClientCreated', {
}, CommonMeta>;

export type InvoicingEvents =
    | InvoiceCreated
    | ClientCreated;
