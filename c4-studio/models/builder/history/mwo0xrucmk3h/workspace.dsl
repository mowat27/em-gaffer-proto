workspace "builder" "The builder: pi agent, tool core, CLI and HTTP API" {

    !identifiers hierarchical

    properties {
        "structurizr.inspection.model.softwaresystem.documentation" "ignore"
        "structurizr.inspection.model.softwaresystem.decisions" "ignore"
        "structurizr.inspection.model.relationship[person->softwaresystem].technology" "ignore"
        "structurizr.inspection.model.relationship[person->container].technology" "ignore"
        "structurizr.inspection.model.relationship[person->component].technology" "ignore"
        "structurizr.inspection.model.relationship[component->component].technology" "ignore"
        "structurizr.inspection.model.relationship[softwaresystem->person].technology" "ignore"
        "structurizr.inspection.model.relationship[container->person].technology" "ignore"
        "structurizr.inspection.workspace.scope" "ignore"
    }

    model {
        builder = softwareSystem "builder" "The builder: pi agent, tool core, CLI and HTTP API"
    }

    views {
        systemContext builder "system-context" "The builder and the people and systems around it." {
            include *
        }

        container builder "containers" "The applications and data stores inside builder." {
            include *
        }
    }
}
