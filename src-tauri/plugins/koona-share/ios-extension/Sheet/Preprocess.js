// Safari runs this in the shared page before the extension opens (NSExtensionJavaScriptPreprocessingFile):
// it hands over the page's address and title, nothing else. The extension itself has no WebView.
var Preprocess = function () {};
Preprocess.prototype = {
  run: function (args) {
    args.completionFunction({ url: document.URL, title: document.title });
  },
};
var ExtensionPreprocessingJS = new Preprocess();
