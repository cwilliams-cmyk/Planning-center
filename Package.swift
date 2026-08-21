// swift-tools-version: 5.9
// Lets you open this folder directly in Xcode (File > Open…) and press Run,
// or run from Terminal with `swift run`. For a proper .app bundle, use
// XcodeGen with project.yml instead (see README).
import PackageDescription

let package = Package(
    name: "SimplePresenter",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "SimplePresenter",
            path: "SimplePresenter"
        )
    ]
)
