import { ConfigObject, ExtensionComponent, PathConfigObject } from './libconfig'

export class ToolConfig extends ExtensionComponent {
  path: PathConfigObject
  args: ConfigObject<string> = new ConfigObject({
    default: '',
    description: 'Arguments to pass to the tool',
  })
  toolName: string
  constructor(toolName: string) {
    super()
    this.toolName = toolName
    this.path = new PathConfigObject(
      {
        description: 'Path to the tool',
      },
      {
        windows: `${toolName}.exe`,
        linux: toolName,
        mac: toolName,
      }
    )
  }
}
