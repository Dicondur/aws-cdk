import * as crypto from 'crypto';
import * as iam from '@aws-cdk/aws-iam';
import { Aws, CfnResource, Construct } from '@aws-cdk/core';
import { InitElement } from './cfn-init-elements';
import { AttachInitOptions, InitBindOptions, InitElementConfig, InitElementType, InitPlatform } from './private/cfn-init-internal';

/**
 * A CloudFormation-init configuration
 */
export class CloudFormationInit {
  /**
   * Build a new config from a set of Init Elements
   */
  public static fromElements(...elements: InitElement[]): CloudFormationInit {
    return CloudFormationInit.fromConfig(new InitConfig(elements));
  }

  /**
   * Use an existing InitConfig object as the default and only config
   */
  public static fromConfig(config: InitConfig): CloudFormationInit {
    return CloudFormationInit.fromConfigSets({
      configSets: {
        default: ['config'],
      },
      configs: { config },
    });
  }

  /**
   * Build a CloudFormationInit from config sets
   */
  public static fromConfigSets(props: ConfigSetProps): CloudFormationInit {
    return new CloudFormationInit(props.configSets, props.configs);
  }

  private readonly _configSets: Record<string, string[]> = {};
  private readonly _configs: Record<string, InitConfig> = {};

  private constructor(configSets: Record<string, string[]>, configs: Record<string, InitConfig>) {
    Object.assign(this._configSets, configSets);
    Object.assign(this._configs, configs);
  }

  /**
   * Add a config with the given name to this CloudFormationInit object
   */
  public addConfig(configName: string, config: InitConfig) {
    if (this._configs[configName]) {
      throw new Error(`CloudFormationInit already contains a config named '${configName}'`);
    }
    this._configs[configName] = config;
  }

  /**
   * Add a config set with the given name to this CloudFormationInit object
   *
   * The new configset will reference the given configs in the given order.
   */
  public addConfigSet(configSetName: string, configNames: string[] = []) {
    if (this._configSets[configSetName]) {
      throw new Error(`CloudFormationInit already contains a configSet named '${configSetName}'`);
    }

    const unk = configNames.filter(c => !this._configs[c]);
    if (unk.length > 0) {
      throw new Error(`Unknown configs referenced in definition of '${configSetName}': ${unk}`);
    }

    this._configSets[configSetName] = [...configNames];
  }

  /**
   * Attach the CloudFormation Init config to the given resource
   *
   * This method does the following:
   *
   * - Renders the `AWS::CloudFormation::Init` object to the given resource's
   *   metadata, potentially adding a `AWS::CloudFormation::Authentication` object
   *   next to it if required.
   * - Updates the instance role policy to be able to call the APIs required for
   *   `cfn-init` and `cfn-signal` to work, and potentially add permissions to download
   *   referenced asset and bucket resources.
   * - Updates the given UserData with commands to execute the `cfn-init` script.
   *
   * As an app builder, use `instance.applyCloudFormationInit()` or
   * `autoScalingGroup.applyCloudFormationInit()` to trigger this method.
   *
   * @internal
   */
  public _attach(attachedResource: CfnResource, attachOptions: AttachInitOptions) {
    // Note: This will not reflect mutations made after attaching.
    const bindResult = this.bind(attachedResource.stack, attachOptions);
    attachedResource.addMetadata('AWS::CloudFormation::Init', bindResult.configData);
    const fingerprint = contentHash(JSON.stringify(bindResult.configData)).substr(0, 16);

    attachOptions.instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStackResource', 'cloudformation:SignalResource'],
      resources: [Aws.STACK_ID],
    }));

    if (bindResult.authData) {
      attachedResource.addMetadata('AWS::CloudFormation::Authentication', bindResult.authData);
    }

    // To identify the resources that have the metadata and where the signal
    // needs to be sent, we need { region, stackName, logicalId }
    const resourceLocator = `--region ${Aws.REGION} --stack ${Aws.STACK_NAME} --resource ${attachedResource.logicalId}`;
    const configSets = (attachOptions.configSets ?? ['default']).join(',');
    const printLog = attachOptions.printLog ?? true;

    if (attachOptions.embedFingerprint ?? true) {
      // It just so happens that the comment char is '#' for both bash and PowerShell
      attachOptions.userData.addCommands(`# fingerprint: ${fingerprint}`);
    }

    if (attachOptions.platform === InitPlatform.WINDOWS) {
      const errCode = attachOptions.ignoreFailures ? '0' : '$LASTEXITCODE';
      attachOptions.userData.addCommands(...[
        `cfn-init.exe -v ${resourceLocator} -c ${configSets}`,
        `cfn-signal.exe -e ${errCode} ${resourceLocator}`,
        ...printLog ? ['type C:\\cfn\\log\\cfn-init.log'] : [],
      ]);
    } else {
      const errCode = attachOptions.ignoreFailures ? '0' : '$?';
      attachOptions.userData.addCommands(...[
        // Run a subshell without 'errexit', so we can signal using the exit code of cfn-init
        '(',
        '  set +e',
        `  /opt/aws/bin/cfn-init -v ${resourceLocator} -c ${configSets}`,
        `  /opt/aws/bin/cfn-signal -e ${errCode} ${resourceLocator}`,
        ...printLog ? ['  cat /var/log/cfn-init.log >&2'] : [],
        ')',
      ]);
    }
  }

  private bind(scope: Construct, options: AttachInitOptions): { configData: any, authData: any } {
    const nonEmptyConfigs = mapValues(this._configs, c => c.isEmpty() ? undefined : c);

    const configNameToBindResult = mapValues(nonEmptyConfigs, c => c._bind(scope, options));

    return {
      configData: {
        configSets: mapValues(this._configSets, configNames => configNames.filter(name => nonEmptyConfigs[name] !== undefined)),
        ...mapValues(configNameToBindResult, c => c.config),
      },
      authData: Object.values(configNameToBindResult).map(c => c.authentication).reduce(deepMerge, undefined),
    };
  }

}

/**
 * A collection of configuration elements
 */
export class InitConfig {
  private readonly elements = new Array<InitElement>();

  constructor(elements: InitElement[]) {
    this.add(...elements);
  }

  /**
   * Whether this configset has elements or not
   */
  public isEmpty() {
    return this.elements.length === 0;
  }

  /**
   * Add one or more elements to the config
   */
  public add(...elements: InitElement[]) {
    this.elements.push(...elements);
  }

  /**
   * Called when the config is applied to an instance.
   * Creates the CloudFormation representation of the Init config and handles any permissions and assets.
   * @internal
   */
  public _bind(scope: Construct, options: AttachInitOptions): InitElementConfig {
    const bindOptions = {
      instanceRole: options.instanceRole,
      platform: options.platform,
      scope,
    };

    const packageConfig = this.bindForType(InitElementType.PACKAGE, bindOptions);
    const groupsConfig = this.bindForType(InitElementType.GROUP, bindOptions);
    const usersConfig = this.bindForType(InitElementType.USER, bindOptions);
    const sourcesConfig = this.bindForType(InitElementType.SOURCE, bindOptions);
    const filesConfig = this.bindForType(InitElementType.FILE, bindOptions);
    const commandsConfig = this.bindForType(InitElementType.COMMAND, bindOptions);
    // Must be last!
    const servicesConfig = this.bindForType(InitElementType.SERVICE, bindOptions);

    const authentication = [ packageConfig, groupsConfig, usersConfig, sourcesConfig, filesConfig, commandsConfig, servicesConfig ]
      .map(c => c?.authentication)
      .reduce(deepMerge, undefined);

    return {
      config: {
        packages: packageConfig?.config,
        groups: groupsConfig?.config,
        users: usersConfig?.config,
        sources: sourcesConfig?.config,
        files: filesConfig?.config,
        commands: commandsConfig?.config,
        services: servicesConfig?.config,
      },
      authentication,
    };
  }

  private bindForType(elementType: InitElementType, renderOptions: Omit<InitBindOptions, 'index'>): InitElementConfig | undefined {
    const elements = this.elements.filter(elem => elem.elementType === elementType);
    if (elements.length === 0) { return undefined; }

    const bindResults = elements.map((e, index) => e._bind({ index, ...renderOptions }));

    return {
      config: bindResults.map(r => r.config).reduce(deepMerge, undefined) ?? {},
      authentication: bindResults.map(r => r.authentication).reduce(deepMerge, undefined),
    };
  }
}

/**
 * Options for CloudFormationInit.withConfigSets
 */
export interface ConfigSetProps {
  /**
   * The definitions of each config set
   */
  readonly configSets: Record<string, string[]>;

  /**
   * The sets of configs to pick from
   */
  readonly configs: Record<string, InitConfig>;
}

/**
 * Deep-merge objects and arrays
 *
 * Treat arrays as sets, removing duplicates. This is acceptable for rendering
 * cfn-inits, not applicable elsewhere.
 */
function deepMerge(target?: Record<string, any>, src?: Record<string, any>) {
  if (target == null) { return src; }
  if (src == null) { return target; }

  for (const [key, value] of Object.entries(src)) {
    if (Array.isArray(value)) {
      if (target[key] && !Array.isArray(target[key])) {
        throw new Error(`Trying to merge array [${value}] into a non-array '${target[key]}'`);
      }
      target[key] = Array.from(new Set([
        ...target[key] ?? [],
        ...value,
      ]));
      continue;
    }
    if (typeof value === 'object' && value) {
      target[key] = deepMerge(target[key] ?? {}, value);
      continue;
    }
    if (value !== undefined) {
      target[key] = value;
    }
  }

  return target;
}

/**
 * Map a function over values of an object
 *
 * If the mapping function returns undefined, remove the key
 */
function mapValues<A, B>(xs: Record<string, A>, fn: (x: A) => B | undefined): Record<string, B> {
  const ret: Record<string, B> = {};
  for (const [k, v] of Object.entries(xs)) {
    const mapped = fn(v);
    if (mapped !== undefined) {
      ret[k] = mapped;
    }
  }
  return ret;
}

function contentHash(content: string) {
  return crypto.createHash('sha256').update(content).digest('hex');
}