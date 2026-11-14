import {DeciderSpecification} from '@event-driven-io/emmett';
import {
    CreateClientCommand,
    CreateClientInitialState,
    decide,
    evolve,
} from './CreateClientCommand';
import {describe, it} from 'node:test';

describe('CreateClient Specification', () => {
    const given = DeciderSpecification.for({
        decide,
        evolve,
        initialState: CreateClientInitialState,
    });

    // spec: Create a client — name example comes from slice.json ("Great GlenLtd");
    // clientId/contactEmail have no examples there, sensible values assumed.
    it('spec: Create a client', () => {
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: 'c1e50001-0000-4000-8000-000000000001',
                name: 'Great GlenLtd',
                contactEmail: 'contact@greatglen.example',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .then([{
                type: 'ClientCreated',
                data: {
                    clientId: 'c1e50001-0000-4000-8000-000000000001',
                    name: 'Great GlenLtd',
                    contactEmail: 'contact@greatglen.example',
                },
                metadata: {},
            }]);
    });

    // spec: Empty name is rejected — "Client name is required"
    it('spec: Empty name is rejected', () => {
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: 'c1e50001-0000-4000-8000-000000000002',
                name: '',
                contactEmail: 'contact@greatglen.example',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows();
    });

    // spec: Invalid contact email is rejected — "Contact email must be a valid email address"
    it('spec: Invalid contact email is rejected', () => {
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: 'c1e50001-0000-4000-8000-000000000003',
                name: 'Great GlenLtd',
                contactEmail: 'not-an-email',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows();
    });
});
