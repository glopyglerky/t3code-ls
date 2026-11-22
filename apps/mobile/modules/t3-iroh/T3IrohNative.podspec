Pod::Spec.new do |s|
  s.name = 'T3IrohNative'
  s.version = '0.0.0'
  s.summary = 'Embedded Iroh transport for T3 Code iOS.'
  s.homepage = 'https://github.com/glopyglerky/t3code-ls'
  s.license = { :type => 'MIT' }
  s.author = 't3code-ls contributors'
  s.platforms = { :ios => '18.0' }
  s.source = { :path => '.' }
  s.static_framework = true
  framework = 'Generated/T3IrohApple.xcframework'
  bindings = 'Generated/t3_iroh_apple.swift'
  framework_present = File.directory?(File.join(__dir__, framework))
  bindings_present = File.file?(File.join(__dir__, bindings))
  if framework_present != bindings_present
    raise 'T3 Iroh requires both the Apple XCFramework and generated Swift bindings.'
  end
  if framework_present
    s.source_files = 'swift/*.swift', bindings
    s.vendored_frameworks = framework
    s.frameworks = 'Network', 'Security', 'SystemConfiguration'
    s.libraries = 'resolv'
    s.pod_target_xcconfig = {
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) T3_IROH_ENABLED',
    }
  else
    s.source_files = 'swift/T3IrohModule.swift'
  end
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
