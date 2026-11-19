workspace "Builder" "C4 model of the builder: the service that builds one event-model slice per job for the gaffer, with its build server, run processes, pi agents, CLI, ops agent and optional factory." {

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
    }

    model {
        operator = person "Builder Operator" "Runs and tunes the builder: starts the build server and agents from the CLI, edits the machine config, reads runs, journals and the machine feed, and talks to the ops agent."

        builder = softwareSystem "Builder" "Builds one slice per job: runs the active builder's workflow (clone, prepare, classify, scaffold, implement, checks, commit) in a fresh clone of the target repository at the requested base, and returns the commits as a patch or a failure reason." {
            factoryUi = container "Builder Factory UI" "The optional Builder screen: the build server's state from the machine feed with start, stop and restart, runs and their journals, operator notifications, the merged machine config, an agent's model, a read-only agent tree, and the factory agent's chat." "TypeScript, React" "Web Browser"
            factoryServer = container "Builder Factory Server" "The builder's optional Tiny Software Factory and a client of the builder CLI. Its builder layer runs builder commands with --json, follows the machine feed, keeps no settings of its own and receives operator notifications. Hosts a durable factory agent with the same builder tools. Nothing in the builder imports it." "Node.js, pi-durable"

            cli = container "Builder CLI" "The builder command line (run, server, agent, tool, tools, runs, logs, attach, events, config, resolve) over the tool core: every builder tool in groups (observe, runs, messaging, operate, process, definitions, verify, git, notify), checked against the machine limit. Also loads the layered machine config and starts or stops the build server." "Node.js 24, TypeScript"
            buildServer = container "Build Server" "The contract adapter: accepts dispatches, checks them against the active builder and the repository, runs one job at a time as a headless workflow run, and posts the patch or reason to the callback. Drains, resumes and cancels through its control inbox. Runs as a run of kind server, configured only by the machine config." "Node.js 24, node:http"
            runProcess = container "Run Process" "One process per run. A workflow run walks its builder's code, template, agent and workflow steps through the engine over one workspace; an agent run prepares its workspace and supervises one pi process in headless, interactive, rpc or durable mode. Owns the run's journal, serves an agent's API, delivers messages and arms a durable run's triggers. Agent steps, sidecars and subagents are child runs." "Node.js 24, TypeScript, Handlebars"
            piAgent = container "Pi Agent" "The pi process of one agent run, for example supabase-api in a job's implement step, the tool-summariser sidecar, the verifier or dev/slice-lab. Runs with discovery off and only the agent's pinned skills, extensions, prompts and settings, plus the journal extension, the gate host and the tool adapter." "pi 1.5.2"
            opsAgent = container "Ops Agent" "An ordinary agent run in durable mode (builder run ops). Investigates failed jobs and reviews the day's jobs, changes definitions and the builder's code on a git branch, checks a fix with a child run, starts and stops the build server, and ends each investigation with an operator notification. Serves the agent API. Never connects to a running job." "pi 1.5.2, Node.js 24"

            agentics = container "Agentics Tree" "One directory per agent (agent.yml, settings.json, prompts), the builder workflows with their Handlebars templates and the active builder, shared skills, extensions, gates, listeners and sample dispatches, and the definition history and change sets." "Files (YAML, TypeScript, Markdown, Handlebars)" "File Store"
            runs = container "Runs" "One folder per run: run.json (spec, state, result), log, journal with blobs and summary, the context store (job and step outputs), pi sessions, pinned definitions, sidecar artefacts, control and journal sockets, and the workspace with the job's clone." "File system" "File Store"
            machineFeed = container "Machine Feed" "One append-only file per machine with server, run, step, job, callback, notification and definition-change events. The one monitoring source." "JSON lines file" "File Store"
            controlFiles = container "Control Files" "The build server's inbox and outbox for drain, resume and cancel, and the log of every operator notification." "JSON files" "File Store"
            machineConfig = container "Machine Config" "Layered YAML (built-in defaults, the builder's config, the user's config, an override file): the tool limit, server settings (host, port, job timeout, callback retries, workspaces kept, active builder, runs directory), the pi command and the notify sinks. Only the operator edits it." "YAML files" "File Store"

            factoryUi -> factoryServer "Calls the builder layer and agent tree routes of, and streams live updates from" "JSON/HTTPS, SSE"
            factoryServer -> cli "Runs builder commands with --json, and follows the machine feed, through" "Node child process"
            factoryServer -> agentics "Shows the agent tree, read only, from" "File I/O"

            cli -> runProcess "Starts and stops runs as, and relays builder attach over the control socket of" "Node child process, JSON lines over Unix socket"
            cli -> buildServer "Starts, stops and restarts, as the builder-server unit or a detached server run," "systemctl, Node child process"
            cli -> runs "Reads run records, journals and context stores from" "File I/O"
            cli -> agentics "Reads and changes definitions, validated and versioned, in" "File I/O"
            cli -> controlFiles "Writes drain, resume and cancel messages to, and records and reads notifications in" "File I/O"
            cli -> machineConfig "Reads and checks the layers of" "File I/O"
            cli -> machineFeed "Replays and follows" "File I/O"

            buildServer -> runProcess "Starts each job as a headless workflow run, waits for it and stops it on cancel in" "Node child process, signals"
            buildServer -> runs "Registers its server run, writes job and callback events to the job's journal and prunes workspaces in" "File I/O"
            buildServer -> machineFeed "Appends its state, job and callback events to" "File I/O"
            buildServer -> controlFiles "Claims drain, resume and cancel messages from, and writes answers to" "File I/O"
            buildServer -> machineConfig "Reads the server settings and tool limit from, at start and at every accept" "File I/O"
            buildServer -> agentics "Loads the active builder from, at every accept" "File I/O"

            runProcess -> piAgent "Starts, supervises and messages one pi process per agent run" "Node child process, pi rpc JSON lines"
            runProcess -> runs "Writes run.json, workspaces, the journal and the context store in" "File I/O"
            runProcess -> machineFeed "Appends run and step events to, and follows failed job results in" "File I/O"
            runProcess -> agentics "Resolves agents, loads builder workflows and pins definitions from" "File I/O"

            piAgent -> runProcess "Streams tool calls and gate decisions to the journal of, and starts child runs as" "JSON lines over Unix socket, Node child process"
            piAgent -> runs "Edits the workspace, writes sessions and done or halt files, and reads the context store in" "File I/O"
            piAgent -> agentics "Reads and changes definitions, validated and versioned, through the tool adapter in" "File I/O"

            opsAgent -> machineFeed "Follows failed job results in, for its job.failed trigger" "File I/O"
            opsAgent -> runs "Reads journals, context stores and run records from" "File I/O"
            opsAgent -> agentics "Changes definitions, validated and versioned, in" "File I/O"
            opsAgent -> runProcess "Checks a fix with a child run started as" "Node child process"
            opsAgent -> controlFiles "Writes drain, resume and cancel messages to, and records notifications in" "File I/O"
            opsAgent -> buildServer "Starts, stops and restarts, draining first," "systemctl"
            opsAgent -> factoryServer "Sends operator notifications to, through a tsf notify sink" "JSON/HTTP"
        }

        gaffer = softwareSystem "Gaffer" "Claims slices from the board, dispatches each to the builder, then applies the patch, runs the gate, merges and pushes." "External"
        targetRepo = softwareSystem "Target Repository" "The application being built, for example mowat27/invoice-lite. The builder reads it with a read-only deploy key." "External"
        llmProvider = softwareSystem "OpenRouter" "Hosts the language models the agents run on, reached through the Agent Vault proxy, which injects the key." "External"
        jev = softwareSystem "TypeSafe Jev" "TypeSafe System One model that answers typed yes/no and score questions." "External"

        operator -> builder "Runs, watches and changes the builder using"
        operator -> builder.cli "Starts agents and workflows, runs the build server, reads runs, journals and the feed, and calls any tool using"
        operator -> builder.factoryUi "Watches the build server, runs and notifications, and changes an agent's model using"
        operator -> builder.opsAgent "Sends messages to and follows the events of, through its API or builder attach,"
        operator -> builder.machineConfig "Edits the server settings, tool limit and notify sinks in"

        builder -> llmProvider "Sends model requests to" "HTTPS via Agent Vault"
        builder.factoryServer -> llmProvider "Sends the factory agent's model requests to" "HTTPS via Agent Vault"
        builder.piAgent -> llmProvider "Sends model requests for each agent run to" "HTTPS via Agent Vault"
        builder.opsAgent -> llmProvider "Sends the ops agent's model requests to" "HTTPS via Agent Vault"

        builder -> targetRepo "Checks it can reach and clones the target repository at base" "git over SSH"
        builder.buildServer -> targetRepo "Checks it can reach the repository of each dispatch" "git ls-remote over SSH"
        builder.runProcess -> targetRepo "Clones the dispatch's repository at base from" "git over SSH"

        builder -> jev "Asks whether a build's tests and scope meet the slice" "JSON/HTTPS"
        builder.runProcess -> jev "Asks for the verifier's judgments in the verify step" "JSON/HTTPS"
        builder.piAgent -> jev "Asks for the verifier's judgments through the verify tool" "JSON/HTTPS"

        gaffer -> builder.buildServer "Dispatches one slice per job to" "JSON/HTTP over Tailscale (POST /slices)"
        builder.buildServer -> gaffer "Sends the done patch or failed reason to" "JSON/HTTP over Tailscale (POST callback)"

        live = deploymentEnvironment "Live" {
            operatorComputer = deploymentNode "Operator's computer" "The operator's laptop." "macOS" {
                deploymentNode "Web Browser" "Opens the Builder screen when the VM runs the factory." "Web browser" {
                    containerInstance builder.factoryUi
                }
            }
            tailnet = deploymentNode "Tailnet" "The private network that carries the contract and reaches the vault." "Tailscale" {
                agentVault = infrastructureNode "Agent Vault" "Proxy that swaps placeholder provider keys for real ones." "Agent Vault proxy"
            }
            exeDev = deploymentNode "exe.dev" "Hosts the sandbox VMs." "exe.dev" {
                exeProxy = infrastructureNode "exe.dev HTTPS proxy" "Serves https://pw-builder-1.exe.xyz from the VM's port 8000 when the VM runs the factory." "exe.dev"
                vm = deploymentNode "pw-builder-1" "The builder VM, created from tsf-base-img with node, git, docker and just. vm.sh launch copies the builder folder and runs its installer." "exe.dev VM" {
                    serverUnit = deploymentNode "builder-server.service" "builder server run under systemd, restarted on failure and at boot. Listens on the VM's tailnet name, port 8788." "systemd, Node.js 24" {
                        server = containerInstance builder.buildServer
                        runProcesses = deploymentNode "Run processes" "One per run of a job: the workflow run and its child runs (the implement step, the summariser sidecar)." "Node.js 24" "" "1..N" {
                            run = containerInstance builder.runProcess
                        }
                        piProcesses = deploymentNode "pi processes" "One per agent run, in the job's clone." "pi 1.5.2" "" "1..N" {
                            agent = containerInstance builder.piAgent
                        }
                    }
                    opsUnit = deploymentNode "builder-ops.service" "Optional (vm.sh launch --ops): builder run ops under systemd, restarted on failure, resuming its durable session. Its API listens on 127.0.0.1:8090." "systemd, Node.js 24, pi 1.5.2" {
                        ops = containerInstance builder.opsAgent
                    }
                    tsfUnit = deploymentNode "tsf-builder.service" "Optional (vm.sh launch --tsf): the builder's factory on port 8000, restarted on failure and at boot." "systemd, Node.js" {
                        factory = containerInstance builder.factoryServer
                    }
                    shell = deploymentNode "Shell" "The builder CLI, run by the operator over SSH, by the installer and by the factory." "bash, Node.js 24" {
                        containerInstance builder.cli
                    }
                    disk = deploymentNode "Builder folder and user config" "The builder folder with its runs and control files, and the user's machine config that the installer writes once and keeps." "Linux file system" {
                        containerInstance builder.agentics
                        containerInstance builder.runs
                        containerInstance builder.machineFeed
                        containerInstance builder.controlFiles
                        containerInstance builder.machineConfig
                    }
                }
                gafferVm = deploymentNode "pw-gaffer-1" "The gaffer VM." "exe.dev VM" {
                    softwareSystemInstance gaffer
                }
            }
            github = deploymentNode "GitHub" "Hosts the target repository." "GitHub" {
                softwareSystemInstance targetRepo
            }
            openRouter = deploymentNode "OpenRouter" "Model API." "OpenRouter" {
                provider = softwareSystemInstance llmProvider
            }
            typeSafe = deploymentNode "TypeSafe" "Hosted System One model API." "TypeSafe" {
                softwareSystemInstance jev
            }

            exeDev.exeProxy -> exeDev.vm.tsfUnit.factory "Forwards requests to" "HTTP"
            exeDev.vm.tsfUnit.factory -> tailnet.agentVault "Sends model requests through" "HTTPS proxy"
            exeDev.vm.serverUnit.piProcesses.agent -> tailnet.agentVault "Sends model requests through" "HTTPS proxy"
            exeDev.vm.opsUnit.ops -> tailnet.agentVault "Sends model requests through" "HTTPS proxy"
            tailnet.agentVault -> openRouter.provider "Forwards model requests with the real key to" "HTTPS"
        }
    }

    views {
        systemContext builder "system-context" "The Builder, its operator and the systems it depends on." {
            include *
        }
        container builder "containers" "The applications and data stores inside the Builder: the build server, run processes and pi agents, the CLI, the ops agent, the optional factory, and the files they share." {
            include *
        }
        deployment builder live "deployment-live" "How the Builder is deployed on its exe.dev VM in the live environment." {
            include *
        }
    }

    configuration {
        scope softwaresystem
    }
}
