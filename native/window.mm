#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

static napi_value configure(napi_env env, napi_callback_info info) {
    size_t count = 1, length = 0;
    napi_value argument, result;
    void* bytes = nullptr;
    napi_get_undefined(env, &result);
    if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 ||
        napi_get_buffer_info(env, argument, &bytes, &length) != napi_ok || length != sizeof(NSView*)) {
        napi_throw_type_error(env, nullptr, "Expected Electron's native NSView handle");
        return nullptr;
    }
    NSView* view = nil;
    std::memcpy(&view, bytes, sizeof(view));
    if (![NSThread isMainThread] || !view.window) {
        napi_throw_error(env, nullptr, "Configure a live window on the main thread");
        return nullptr;
    }
    // Electron exposes Spaces flags, but not Stationary: Show Desktop otherwise
    // slides this window offscreen while isVisible/isFocused still report true.
    view.window.collectionBehavior = (view.window.collectionBehavior &
        ~(NSWindowCollectionBehaviorManaged | NSWindowCollectionBehaviorTransient)) |
        NSWindowCollectionBehaviorStationary;
    return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_value function;
    napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, nullptr, &function);
    napi_set_named_property(env, exports, "configure", function);
    return exports;
}
NAPI_MODULE(clax_window, initialize)
